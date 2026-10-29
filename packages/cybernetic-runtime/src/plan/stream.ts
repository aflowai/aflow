import { isFindingsCarrier } from './carrier.js';
/**
 * A stream continues on a schedule (Plan 322 P2b), and the space's resident
 * takes the whole board (Plan 331 D2). A wake is a Helmsman run whose first
 * call is `plan.node.next`, and this is the one authority over the answer:
 * with a root, that stream's decision; with none, every open root in position
 * order, each decided as one stream is, the decisions ranked finish before
 * start across the board (D3). The decision is read from records — the
 * active node, its runs, its links, its spend, the space's attention items
 * and its pull request as GitHub answers — by rules, so no wake decides by
 * how its prompt reads. It writes nothing to the plan and starts nothing —
 * the wake acts on the decision — except that actionable work claims the state
 * it was decided on, so two wakes that read alike cannot both commission or publish.
 */
import type { Redis } from 'ioredis';
import {
  isClosedPlanNodeStatus,
  OPEN_PLAN_NODE_STATUSES,
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_NODE_PROPOSED_HEAD,
  PLAN_NODE_RUNS_LIMIT,
  PLAN_STREAM_COMMISSION_SLUG,
  PLAN_STREAM_SPEND_CENTS_DEFAULT,
  PLAN_STREAM_PUBLICATION_SLUG,
  type PlanBoardDecision,
  type PlanBoardNext,
  type PlanNode,
  type PlanNodeLink,
  type PlanNodeListTruncation,
  type PlanNodeNextInput,
  type PlanNodeRun,
  type PlanNodeSummary,
  type PlanStreamAnswer,
  type PlanStreamBriefNode,
  type PlanStreamCommission,
  type PlanStreamNode,
  type PlanStreamPullRequestAnswer,
  type PlanStreamRetry,
  type PlanStreamSpend,
  type PlanStreamStopCause,
  type PlanStreamWaitCause,
} from '@aflow/schemas';
import {
  getPlanNode,
  PLAN_TREE_WALK_BOUNDS,
  type PlanOpResult,
  type PlanReadContext,
} from './operations.js';
import { askedRevision, isAsked, planAsk, claimAsk } from './asks.js';
import { bySiblingOrder } from './tree.js';

/** How many of a node's own rounds a firing reads, newest first. */
export const PLAN_STREAM_ROUNDS_LIMIT = 50;

/** A commission or a publication run serving a node, as a firing reads it. */
export interface PlanStreamRun {
  runId: string;
  slug: string;
  /** `running`, `paused`, `completed`, `failed` or `cancelled`. */
  status: string;
  startedAt: string;
  /** The run's own account of its failure, where it failed. */
  failure?: string;
  wakeSessionId?: string;
}

/** What a publication that completed promoted. */
export interface PlanPublicationOutcome {
  prUrl?: string;
  afterReview?: string;
  pushDecision?: string;
  reviewRunId?: string;
}

/** What a completed commission made, as its publication takes it. */
export interface PlanCommissionOutcome {
  patchRef?: string;
  baseSha?: string;
  mergeFrom?: string;
  bindingId?: string;
}

/** What the runs serving a node cost since a person last opened it (Plan 331 D4). */
export interface PlanNodeSpendRead {
  cents: number;
  /** The runs serving the node in that span, newest first. */
  runIds: string[];
  /**
   * The scheduled Helmsman sessions that started them. `cents` includes each
   * one's share: its cost divided across the nodes it started runs for.
   */
  wakeSessionIds: string[];
}

/** The reads a firing makes past the plan's own tables. */
export interface PlanStreamReads {
  /** The node's own commissions and publications, newest first, at most `limit`. */
  roundsOf(spaceId: string, nodeId: string, limit: number): Promise<PlanStreamRun[]>;
  /** What a completed publication promoted; null where it cannot be read. */
  publicationOutcome(spaceId: string, runId: string): Promise<PlanPublicationOutcome | null>;
  /** What a completed commission made; null where it cannot be read. */
  commissionOutcome(spaceId: string, runId: string): Promise<PlanCommissionOutcome | null>;
  /** The publications that name this commission run as their `commission`, whatever they serve. */
  publicationsOf(spaceId: string, commissionRunId: string): Promise<PlanStreamRun[]>;
  /** The spend of the runs serving the node since a person last opened it. */
  spendOf(spaceId: string, nodeId: string): Promise<PlanNodeSpendRead>;
  /** The space's pending `workflow_run_paused` attention items about runs serving these nodes. */
  pausedItemsServing(spaceId: string, nodeIds: readonly string[]): Promise<number>;
}

export interface PlanStreamContext extends PlanReadContext {
  reads: PlanStreamReads;
  redis: Redis;
  tenantId: string;
  /** The firing asking: its session. A claim it holds is its own to decide on again. */
  holder: string;
}

// ============================================================================
// The claim on a `continue`
// ============================================================================

/**
 * How long a firing's claim on the state it read holds. It needs to outlast
 * the start of the commission it decided, after which that commission is in
 * flight and holds the next firing back itself; a firing that never starts it
 * gives the state back when the claim lapses.
 */
export const PLAN_STREAM_CLAIM_TTL_MS = 30 * 60_000;

/**
 * The state a `continue` was decided on: the node's revision, its newest
 * round and its newest pull request. Two firings that read the same records
 * name the same key; any write, round or pull request since names another.
 */
export function streamClaimKey(
  ctx: Pick<PlanStreamContext, 'tenantId' | 'spaceId'>,
  node: PlanNode,
  rounds: readonly PlanStreamRun[],
  pullRequestLink: PlanNodeLink | undefined,
): string {
  return [
    'plan:stream:claim',
    ctx.tenantId,
    ctx.spaceId,
    node.nodeId,
    String(node.revision),
    rounds[0]?.runId ?? '-',
    pullRequestLink?.ref ?? '-',
  ].join(':');
}

/**
 * Take the state for this firing, by a write that lands only where none
 * holds it — the one serialization point between firings that read alike, so
 * at most one of them commissions. The holder that took it may take it again.
 */
export async function claimStreamState(ctx: PlanStreamContext, key: string): Promise<boolean> {
  const taken = await ctx.redis.set(key, ctx.holder, 'PX', PLAN_STREAM_CLAIM_TTL_MS, 'NX');
  if (taken === 'OK') return true;
  return (await ctx.redis.get(key)) === ctx.holder;
}

// ============================================================================
// The active node
// ============================================================================

/**
 * Walk down from the root, by sibling order, into the first child that is not
 * closed, and on from there. The walk stops at a node with no open child, or
 * at the first node that is not `active` — a `blocked` node ends it whatever
 * lies under or after it, so a stop holds the whole stream. A closed root has
 * no active node.
 */
export function findActiveStreamNode(
  nodes: readonly PlanNodeSummary[],
  rootId: string,
): PlanNodeSummary | null {
  const root = nodes.find((n) => n.nodeId === rootId);
  if (!root || isClosedPlanNodeStatus(root.status)) return null;
  const openChildren = new Map<string, PlanNodeSummary[]>();
  for (const node of nodes) {
    if (node.parentId === null || isClosedPlanNodeStatus(node.status)) continue;
    const siblings = openChildren.get(node.parentId) ?? [];
    siblings.push(node);
    openChildren.set(node.parentId, siblings);
  }
  const visited = new Set<string>();
  let node = root;
  for (;;) {
    visited.add(node.nodeId);
    if (node.status !== 'active') return node;
    const next = (openChildren.get(node.nodeId) ?? []).sort(bySiblingOrder)[0];
    if (!next || visited.has(next.nodeId)) return node;
    node = next;
  }
}

// ============================================================================
// The decision
// ============================================================================

export interface PlanStreamFacts {
  node: PlanNode;
  /** Runs in flight for the node and every node under it, whoever drove them. */
  inFlight: readonly PlanNodeRun[];
  /** The bound that stopped the read of the nodes under it, where one did: `inFlight` may miss runs below it. */
  inFlightUnread?: PlanNodeListTruncation;
  /** Pending pauses in the space's attention items about runs serving those nodes. */
  pausedItems: number;
  /** The node's newest `pull_request` link. */
  pullRequestLink?: PlanNodeLink;
  /** The node holds a `merge` link to its newest pull request: that merge was judged. */
  mergeJudged: boolean;
  /** GitHub's answer for that pull request, where the caller read it. */
  pullRequest?: PlanStreamPullRequestAnswer;
  /** The node's own commissions and publications, newest first. */
  rounds: readonly PlanStreamRun[];
  /** What the newest round since the node's last write promoted, where it is a completed publication. */
  publication?: PlanPublicationOutcome | null;
  /** What the newest round since the node's last write made, where it is a completed commission. */
  commission?: PlanCommissionOutcome | null;
  /** The publications naming that commission, whatever node they serve. */
  commissionPublications?: readonly PlanStreamRun[];
  attempts: number;
  /** What the node spent since a person last opened it, where it was read. */
  spend?: PlanNodeSpendRead;
  spendCents: number;
}

const ENDED = new Set(['completed', 'failed', 'cancelled']);

function at(iso: string): number {
  return Date.parse(iso);
}

function streamNode(node: PlanNode | PlanNodeSummary): PlanStreamNode {
  return {
    nodeId: node.nodeId,
    title: node.title,
    status: node.status,
    revision: node.revision,
    updatedAt: node.updatedAt,
  };
}

function briefNode(node: PlanNode): PlanStreamBriefNode {
  return {
    ...streamNode(node),
    goal: node.goal,
    criteria: node.criteria,
    ...(node.note !== undefined ? { note: node.note } : {}),
  };
}

/** `https://github.com/<owner>/<repo>/pull/<number>`, as a publication links it. */
export function parsePullRequestUrl(
  url: string,
): { owner: string; repo: string; number: number } | null {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url);
  if (!match) return null;
  const number = Number(match[3]);
  return Number.isSafeInteger(number) && number > 0
    ? { owner: match[1]!, repo: match[2]!, number }
    : null;
}

/** What a node's note begins with once a merge that did not meet its criteria is recorded. */
export function mergeNoteHead(url: string, mergeCommitSha?: string | null): string {
  return `Merged ${url}${mergeCommitSha ? ` at ${mergeCommitSha}` : ''}`;
}

/**
 * A `merge` link's label: when the pull request merged and, where GitHub named
 * it, as which commit. `mergeShaOf` reads the commit back for the board.
 */
export function mergeLinkLabel(mergedAt: string, mergeCommitSha?: string | null): string {
  return `merged ${mergeCommitSha ? `as ${mergeCommitSha} ` : ''}at ${mergedAt}`;
}

export function mergeShaOf(label: string | undefined): string | undefined {
  return /^merged as (\S+) at /.exec(label ?? '')?.[1];
}

function wait(
  cause: PlanStreamWaitCause,
  reason: string,
  node?: PlanNode | PlanNodeSummary,
): PlanStreamAnswer {
  return { decision: 'wait', cause, reason, ...(node ? { node: streamNode(node) } : {}) };
}

function blockedNote(node: PlanNode, why: string): string {
  const head = `Blocked: ${why}`;
  const note = node.note !== undefined ? `${head}\n${node.note}` : head;
  return note.slice(0, PLAN_NODE_PROSE_MAX_CHARS);
}

function stop(
  node: PlanNode,
  cause: PlanStreamStopCause,
  why: string,
  spend?: PlanStreamSpend,
): PlanStreamAnswer {
  return {
    decision: 'stop',
    cause,
    reason: `${why} The stream holds here until a person moves the node out of blocked.`,
    node: streamNode(node),
    update: {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      status: 'blocked',
      note: blockedNote(node, why),
    },
    ...(spend ? { spend } : {}),
  };
}

/** How many runs a stop's note names; the decision's `spend` carries them all. */
const NAMED_RUNS = 5;

function namedRuns(runIds: readonly string[]): string {
  const named = runIds.slice(0, NAMED_RUNS).join(', ');
  const more = runIds.length - NAMED_RUNS;
  return more > 0 ? `${named} and ${String(more)} more` : named;
}

function cents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

/** The node's runs cost its ceiling or more since a person last opened it (Plan 331 D4). */
function spendStop(facts: PlanStreamFacts): PlanStreamAnswer | null {
  const { spend } = facts;
  if (!spend || spend.cents < facts.spendCents) return null;
  return stop(
    facts.node,
    'spend_spent',
    `Its runs cost ${cents(spend.cents)} since a person last opened it, at or past its ${cents(facts.spendCents)} ceiling: ${namedRuns(spend.runIds)}${spend.wakeSessionIds.length > 0 ? `, started by wake ${namedRuns(spend.wakeSessionIds)}` : ''}.`,
    {
      cents: spend.cents,
      ceilingCents: facts.spendCents,
      runIds: spend.runIds,
      wakeSessionIds: spend.wakeSessionIds,
    },
  );
}

/**
 * A wake-started commission is published by the wake that reads it (Plan 331
 * D3.1): the run that started it has ended by the time it completes.
 */
function answerCompletedCommission(facts: PlanStreamFacts, latest: PlanStreamRun): RoundAnswer {
  const { node } = facts;
  const ran = `${latest.slug} run ${latest.runId}`;
  const outcome = facts.commission;
  if (outcome === null || outcome === undefined) {
    return {
      kind: 'decided',
      output: wait('read_failed', `What the ${ran} made could not be read.`, node),
    };
  }
  const elsewhere = facts.commissionPublications?.[0];
  if (elsewhere) {
    return {
      kind: 'decided',
      output: wait(
        'unknown_state',
        `The ${ran} was published by ${elsewhere.slug} run ${elsewhere.runId}, which does not serve this node; a person links its pull request to the node.`,
        node,
      ),
    };
  }
  if (outcome.patchRef === undefined) {
    return {
      kind: 'decided',
      output: stop(
        node,
        'commission_unchanged',
        `The ${ran} completed with no change to publish; a person reads it and says what the node needs.`,
      ),
    };
  }
  if (!latest.wakeSessionId) {
    return {
      kind: 'decided',
      output: wait(
        'awaiting_publication',
        'The operator conversation that started this commission owns its publication.',
        node,
      ),
    };
  }
  const commission: PlanStreamCommission = {
    commission: latest.runId,
    patchRef: outcome.patchRef,
    ...(outcome.baseSha !== undefined ? { baseSha: outcome.baseSha } : {}),
    ...(outcome.mergeFrom !== undefined ? { mergeFrom: outcome.mergeFrom } : {}),
    ...(outcome.bindingId !== undefined ? { bindingId: outcome.bindingId } : {}),
  };
  return {
    kind: 'decided',
    output: {
      decision: 'publish',
      reason: `The ${ran} completed with a change and no publication of it has started; publish it under its summary.`,
      node: briefNode(node),
      commission,
    },
  };
}

/** The rounds started after `since`, newest first. */
function startedAfter(rounds: readonly PlanStreamRun[], since: string): PlanStreamRun[] {
  return rounds.filter((run) => at(run.startedAt) > at(since));
}

/**
 * The commissions that ended without the node gaining a pull request, among
 * those started since its last write: what a re-commission spends.
 */
function attemptsUsed(facts: PlanStreamFacts): number {
  const since =
    facts.pullRequestLink && at(facts.pullRequestLink.createdAt) > at(facts.node.updatedAt)
      ? facts.pullRequestLink.createdAt
      : facts.node.updatedAt;
  return startedAfter(facts.rounds, since).filter(
    (run) => run.slug === PLAN_STREAM_COMMISSION_SLUG && ENDED.has(run.status),
  ).length;
}

/** The round the newest run since the node's last write calls for, if any. */
type RoundAnswer =
  | { kind: 'fresh' }
  | { kind: 'retry'; retry: PlanStreamRetry }
  | { kind: 'decided'; output: PlanStreamAnswer };

function answerLatestRound(facts: PlanStreamFacts): RoundAnswer {
  const { node } = facts;
  const latest = roundToAnswer(facts.rounds, node.updatedAt);
  if (!latest) return { kind: 'fresh' };
  if (
    latest.slug === PLAN_STREAM_COMMISSION_SLUG &&
    at(latest.startedAt) <= at(node.updatedAt) &&
    facts.commission != null &&
    facts.commission.patchRef === undefined
  ) {
    return { kind: 'fresh' };
  }
  const ran = `${latest.slug} run ${latest.runId}`;
  const failure = latest.failure !== undefined ? { failure: latest.failure } : {};
  if (latest.slug === PLAN_STREAM_COMMISSION_SLUG) {
    switch (latest.status) {
      case 'failed':
        return {
          kind: 'retry',
          retry: { cause: 'commission_failed', runId: latest.runId, slug: latest.slug, ...failure },
        };
      case 'cancelled':
        return {
          kind: 'retry',
          retry: { cause: 'commission_cancelled', runId: latest.runId, slug: latest.slug },
        };
      case 'completed':
        return answerCompletedCommission(facts, latest);
    }
  } else {
    switch (latest.status) {
      case 'failed':
        return {
          kind: 'retry',
          retry: {
            cause: 'publication_failed',
            runId: latest.runId,
            slug: latest.slug,
            ...failure,
          },
        };
      case 'completed': {
        const outcome = facts.publication;
        if (outcome === null || outcome === undefined) {
          return {
            kind: 'decided',
            output: wait('read_failed', `What the ${ran} promoted could not be read.`, node),
          };
        }
        if (outcome.prUrl === undefined && outcome.afterReview === 'fix_before_merge') {
          return {
            kind: 'retry',
            retry: {
              cause: 'fix_before_merge',
              runId: latest.runId,
              slug: latest.slug,
              ...(outcome.reviewRunId !== undefined ? { reviewRunId: outcome.reviewRunId } : {}),
            },
          };
        }
        if (outcome.prUrl === undefined && outcome.pushDecision === 'ask') {
          return {
            kind: 'decided',
            output: stop(
              node,
              'publication_denied',
              `The operator declined the push of ${ran}; commissioning it again would ask the question they just answered.`,
            ),
          };
        }
        break;
      }
    }
  }
  return {
    kind: 'decided',
    output: wait(
      'unknown_state',
      `The ${ran} is ${latest.status}, a state no rule of the stream answers; a person reads it.`,
      node,
    ),
  };
}

function roundToAnswer(
  rounds: readonly PlanStreamRun[],
  updatedAt: string,
): PlanStreamRun | undefined {
  const latest = rounds[0];
  // A stop and Resume write the node after its resident patch completed. That patch
  // still owns its publication, until a publication or newer commission exists.
  return latest?.slug === PLAN_STREAM_COMMISSION_SLUG &&
    latest.status === 'completed' &&
    latest.wakeSessionId !== undefined
    ? latest
    : latestRoundSinceWrite(rounds, updatedAt);
}

function latestRoundSinceWrite(
  rounds: readonly PlanStreamRun[],
  updatedAt: string,
): PlanStreamRun | undefined {
  return startedAfter(rounds, updatedAt)[0];
}

/**
 * The firing's decision on the active node, the first rule that holds
 * deciding: a blocked node is the person's, whatever its pull request says,
 * and a `decide` node is the operator's to answer;
 * `wait` while its own work is in flight, or the read of the nodes under it
 * stopped at a bound before it could show none is; a merge of its newest pull request
 * nobody has acted on is recorded next; then `wait` while that pull request
 * is open or a read failed; `publish` where its last commission completed with a change
 * nothing published; `stop` where its pull request was closed unmerged, its spend
 * reached its ceiling, its push was declined, a commission made no change or its attempts
 * are spent;
 * `continue` where its next step is the work or its last round failed within the budget.
 * Anything else is `wait`.
 */
export function decideStreamFiring(facts: PlanStreamFacts): PlanStreamAnswer {
  const { node } = facts;
  if (node.status === 'blocked') {
    return wait('blocked', `"${node.title}" is blocked, waiting on a person.`, node);
  }
  // A decision is the operator's choice, not a run's work (D2): its Action
  // Center item asks for it, and the walk passes it once the answer closes it.
  if (node.kind === 'decide') {
    return wait(
      'awaiting_decision',
      `"${node.title}" is a decision, the operator's to make in the Action Center or on the plan page; the stream holds until it is answered.`,
      node,
    );
  }

  // The node's own work settles before any merge is judged: a merge read while a
  // commission or publication of the node runs would advance past work in flight.
  if (facts.inFlight.length > 0 || facts.pausedItems > 0) {
    const runs = facts.inFlight
      .slice(0, 5)
      .map((run) => `${run.slug} run ${run.runId} (${run.status})`);
    const named =
      runs.length > 0
        ? runs.join(', ')
        : `${String(facts.pausedItems)} paused run(s) in the space's attention items`;
    return wait('in_flight', `Work for "${node.title}" is in flight: ${named}.`, node);
  }
  if (facts.inFlightUnread) {
    const { bound, value } = facts.inFlightUnread;
    return wait(
      'read_failed',
      `The read of the nodes under "${node.title}" stopped at its ${bound} bound of ${String(value)}, so work in flight below it cannot be ruled out.`,
      node,
    );
  }

  const link = facts.pullRequestLink;
  let pullRequest: Extract<PlanStreamPullRequestAnswer, { read: 'ok' }> | undefined;
  if (link) {
    const answer = facts.pullRequest;
    if (answer?.url !== link.ref) {
      const parsed = parsePullRequestUrl(link.ref);
      if (!parsed) {
        return wait(
          'unknown_state',
          `The pull request link ${link.ref} names no pull request this stream can read.`,
          node,
        );
      }
      return {
        decision: 'read_pull_request',
        reason: `The answer turns on ${link.ref}, the node's newest pull request, as GitHub reads it now.`,
        node: streamNode(node),
        pullRequest: { url: link.ref, ...parsed },
      };
    }
    if (answer.read === 'failed') {
      return wait(
        'read_failed',
        `${link.ref} could not be read, and a firing that cannot see the node's work adds none to it.`,
        node,
      );
    }
    pullRequest = answer;
    if (answer.merged && answer.mergedAt != null) {
      const mergedAt = answer.mergedAt;
      const actedOn = facts.rounds.some(
        (run) => run.slug === PLAN_STREAM_COMMISSION_SLUG && at(run.startedAt) > at(mergedAt),
      );
      if (!actedOn && !facts.mergeJudged) {
        return {
          decision: 'record_merge',
          reason: `${link.ref} merged at ${mergedAt} and no commission of the node has started since; judge the node against its criteria with the merged change in hand.`,
          node: briefNode(node),
          pullRequest: {
            url: link.ref,
            mergedAt,
            ...(answer.mergeCommitSha ? { mergeCommitSha: answer.mergeCommitSha } : {}),
          },
          noteHead: mergeNoteHead(link.ref, answer.mergeCommitSha),
          liveCheck: {
            ...(node.parentId !== null ? { parentId: node.parentId } : {}),
            kind: 'investigate',
            title: node.title,
            goal: node.goal,
            criteria: node.criteria,
            liveCheck: {
              pullRequest: link.ref,
              ...(answer.mergeCommitSha ? { mergeCommitSha: answer.mergeCommitSha } : {}),
            },
          },
          link: {
            nodeId: node.nodeId,
            kind: 'merge',
            ref: link.ref,
            label: mergeLinkLabel(mergedAt, answer.mergeCommitSha),
          },
        };
      }
    }
  }

  if (link && pullRequest && !pullRequest.merged) {
    if (pullRequest.state === 'open') {
      return wait('pull_request_open', `${link.ref} is open and unmerged.`, node);
    }
    // A person who writes the node after the close has said what the work is now.
    if (pullRequest.closedAt != null && at(pullRequest.closedAt) > at(node.updatedAt)) {
      return stop(
        node,
        'pull_request_closed',
        `${link.ref} was closed without being merged; the next step would build on a change that will not land.`,
      );
    }
  }

  const round = answerLatestRound(facts);
  if (
    round.kind === 'decided' &&
    (round.output.decision === 'publish' ||
      (round.output.decision === 'wait' && round.output.cause === 'awaiting_publication'))
  )
    return round.output;

  // Recording a merge and publishing a finished patch take precedence over new work.
  const spent = spendStop(facts);
  if (spent) return spent;

  if (round.kind === 'decided') return round.output;
  const used = attemptsUsed(facts);
  if (round.kind === 'retry' && used > facts.attempts) {
    return stop(
      node,
      'attempts_spent',
      `${String(used)} rounds of the node ended without a pull request since it was last written, past its ${String(facts.attempts)} attempts; the last was ${round.retry.slug} run ${round.retry.runId}.`,
    );
  }
  return {
    decision: 'continue',
    reason:
      round.kind === 'retry'
        ? `The ${round.retry.slug} run ${round.retry.runId} ended at ${round.retry.cause}; commission the node again, briefed from that run.`
        : `No commission of "${node.title}" has started since it was last written; its next step is the work, based on origin/<base> — never on the connected folder.`,
    node: briefNode(node),
    ...(round.kind === 'retry' ? { retry: round.retry } : {}),
    attemptsUsed: used,
    attempts: facts.attempts,
  };
}

// ============================================================================
// plan.node.next
// ============================================================================

type StreamRoot = Pick<PlanNodeSummary, 'nodeId' | 'title' | 'status'>;

/** A stream's decision and the claim on work it would start. */
interface RootDecision {
  answer: PlanStreamAnswer;
  claim?: { key: string; node: PlanNode };
  ask?: { node: PlanNode; record: string | null };
}

/** Read what one stream's decision turns on, and decide; nothing is claimed here. */
async function decideRoot(
  ctx: PlanStreamContext,
  root: StreamRoot,
  input: PlanNodeNextInput,
): Promise<PlanOpResult<RootDecision>> {
  const decided = (answer: PlanStreamAnswer) => ({ ok: true as const, answer });
  if (isClosedPlanNodeStatus(root.status)) {
    return decided(
      wait(
        'stream_closed',
        `The stream's root "${root.title}" is ${root.status}; nothing under it is the stream's to start.`,
      ),
    );
  }

  const open = await ctx.store.walk(ctx.spaceId, {
    rootId: root.nodeId,
    statuses: OPEN_PLAN_NODE_STATUSES,
    ...PLAN_TREE_WALK_BOUNDS,
  });
  const active = findActiveStreamNode(open.nodes, root.nodeId);
  if (!active) {
    return decided(wait('stream_closed', `The stream under "${root.title}" has no open node.`));
  }

  const opened = await getPlanNode(ctx, active.nodeId);
  if (!opened.ok) return opened;
  // A walk cut short may not have read the active node's open children.
  if (
    open.truncated !== undefined &&
    active.status === 'active' &&
    opened.children.some((child) => !isClosedPlanNodeStatus(child.status))
  ) {
    return decided(
      wait(
        'read_failed',
        `The walk of the stream stopped at its ${open.truncated.bound} bound before it found the active node.`,
        active,
      ),
    );
  }
  if (
    opened.node.status === 'blocked' &&
    opened.node.kind !== 'decide' &&
    input.rootNodeId === undefined
  ) {
    const record = await askedRevision(ctx, opened.node.nodeId);
    if (!isAsked(opened.node, record)) {
      const ask = planAsk(opened.node);
      return {
        ok: true,
        answer: {
          decision: 'ask',
          reason: ask.waitsOn,
          node: streamNode(opened.node),
          ...ask,
        },
        ask: { node: opened.node, record },
      };
    }
  }
  // Nothing past this line is read for a node no rule would act on.
  if (opened.node.status === 'blocked' || opened.node.kind === 'decide') {
    return decided(
      decideStreamFiring({
        node: opened.node,
        inFlight: [],
        pausedItems: 0,
        mergeJudged: false,
        rounds: [],
        attempts: input.attempts,
        spendCents: opened.node.spendCents ?? PLAN_STREAM_SPEND_CENTS_DEFAULT,
      }),
    );
  }

  // Every status: a run serving a node closed under the active one is still in
  // flight. Where the walk's bounds cut it short, the runs below are unread, and
  // the decision is told so rather than shown fewer runs.
  const subtree: { nodes: PlanNodeSummary[]; truncated?: PlanNodeListTruncation } =
    active.nodeId === root.nodeId && opened.childrenTotal > 0 && !open.truncated
      ? await readRootHistory(ctx, root.nodeId)
      : await ctx.store.walk(ctx.spaceId, {
          rootId: active.nodeId,
          ...PLAN_TREE_WALK_BOUNDS,
        });
  const servedNodeIds = subtree.nodes.map((n) => n.nodeId);
  const [rounds, inFlight, pausedItems, spend] = await Promise.all([
    ctx.reads.roundsOf(ctx.spaceId, active.nodeId, PLAN_STREAM_ROUNDS_LIMIT),
    ctx.store.listRunsServing(ctx.spaceId, servedNodeIds, PLAN_NODE_RUNS_LIMIT),
    ctx.reads.pausedItemsServing(ctx.spaceId, servedNodeIds),
    ctx.reads.spendOf(ctx.spaceId, active.nodeId),
  ]);
  const latest = roundToAnswer(rounds, opened.node.updatedAt);
  const completed = latest?.status === 'completed' ? latest : undefined;
  const publication =
    completed?.slug === PLAN_STREAM_PUBLICATION_SLUG
      ? await ctx.reads.publicationOutcome(ctx.spaceId, completed.runId)
      : undefined;
  const [commission, commissionPublications] =
    completed?.slug === PLAN_STREAM_COMMISSION_SLUG
      ? await Promise.all([
          ctx.reads.commissionOutcome(ctx.spaceId, completed.runId),
          ctx.reads.publicationsOf(ctx.spaceId, completed.runId),
        ])
      : [undefined, undefined];
  // Read by kind and by key, never from `opened.links`, a page that a node with
  // many links would carry these records past.
  const pullRequestLink =
    (await ctx.store.newestLink(ctx.spaceId, active.nodeId, 'pull_request')) ?? undefined;
  const mergeJudged =
    pullRequestLink !== undefined &&
    (await ctx.store.findLink(ctx.spaceId, active.nodeId, 'merge', pullRequestLink.ref)) !== null;

  const answer = decideStreamFiring({
    node: opened.node,
    mergeJudged,
    inFlight: inFlight.runs,
    ...(subtree.truncated ? { inFlightUnread: subtree.truncated } : {}),
    pausedItems,
    ...(pullRequestLink ? { pullRequestLink } : {}),
    ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
    rounds,
    ...(publication !== undefined ? { publication } : {}),
    ...(commission !== undefined ? { commission } : {}),
    ...(commissionPublications !== undefined ? { commissionPublications } : {}),
    attempts: input.attempts,
    spend,
    spendCents: opened.node.spendCents ?? PLAN_STREAM_SPEND_CENTS_DEFAULT,
  });
  if (answer.decision === 'publish') {
    return {
      ok: true,
      answer,
      claim: {
        key: ['plan:stream:publish', ctx.tenantId, ctx.spaceId, answer.commission.commission].join(
          ':',
        ),
        node: opened.node,
      },
    };
  }
  if (answer.decision !== 'continue') return decided(answer);
  if (!answer.retry && active.nodeId === root.nodeId && opened.childrenTotal > 0) {
    if (open.truncated)
      return decided(
        wait('read_failed', 'The root’s open children could not all be read.', opened.node),
      );
    return decided(
      wait('stream_closed', `The children of "${root.title}" are closed.`, opened.node),
    );
  }
  return {
    ok: true,
    answer,
    claim: { key: streamClaimKey(ctx, opened.node, rounds, pullRequestLink), node: opened.node },
  };
}

function claimedWait(node: PlanNode): PlanStreamAnswer {
  return wait(
    'claimed',
    `Another firing claimed work for "${node.title}" on the state this one read, and is starting it.`,
    node,
  );
}

/** One stream: read what its decision turns on, and decide. */
export async function nextInPlanStream(
  ctx: PlanStreamContext,
  rootNodeId: string,
  input: PlanNodeNextInput,
): Promise<PlanOpResult<{ output: PlanStreamAnswer }>> {
  const root = await ctx.store.find(ctx.spaceId, rootNodeId);
  if (!root) {
    return {
      ok: false,
      code: 'PLAN_NODE_NOT_FOUND',
      message: `No plan node "${rootNodeId}" in this space to continue as a stream. The schedule names a node that is gone: the operator removes or changes it.`,
      details: { nodeId: rootNodeId },
    };
  }
  const decided = await decideRoot(ctx, root, input);
  if (!decided.ok) return decided;
  if (!decided.claim) return { ok: true, output: decided.answer };
  const claimed = await claimStreamState(ctx, decided.claim.key);
  return { ok: true, output: claimed ? decided.answer : claimedWait(decided.claim.node) };
}

/**
 * Where a decision stands in the wake's order (Plan 331 D3): finish before
 * start — a merge recorded, a commission published, a stop written, a failed
 * round re-commissioned, then new work. Pull request reads follow work so
 * unchanged open PRs cannot consume every decision slot.
 */
export function boardRank(answer: PlanStreamAnswer): number {
  switch (answer.decision) {
    case 'record_merge':
      return 0;
    case 'publish':
      return 1;
    case 'ask':
      return 7;
    case 'read_pull_request':
      return 6;
    case 'stop':
      return 3;
    case 'continue':
      return answer.retry ? 4 : 5;
    case 'wait':
      return 8;
  }
}

async function readRootHistory(ctx: PlanStreamContext, rootId: string) {
  return ctx.store.walk(ctx.spaceId, {
    rootId,
    statuses: ['active', 'blocked', 'waiting', 'dropped'],
    ...PLAN_TREE_WALK_BOUNDS,
  });
}

/**
 * The whole board (Plan 331 D2): every open root in position order — the
 * operator's priority — decided as one stream is. The decisions that are not
 * `wait` come back ranked finish-first, the root order breaking ties, at most
 * `input.decisions` of them; a `continue` is claimed only once it is among
 * those, so a decision left to the next wake holds nothing back.
 */
export async function nextOnPlanBoard(
  ctx: PlanStreamContext,
  input: PlanNodeNextInput,
): Promise<PlanOpResult<{ output: PlanBoardNext }>> {
  const open = await ctx.store.walk(ctx.spaceId, {
    statuses: OPEN_PLAN_NODE_STATUSES,
    ...PLAN_TREE_WALK_BOUNDS,
  });
  const roots = open.nodes.filter((node) => node.parentId === null).sort(bySiblingOrder);

  const candidates: Array<RootDecision & { root: PlanBoardDecision['root']; order: number }> = [];
  const exhaustedRoots = new Set<string>();
  const waits = new Map<PlanStreamWaitCause, number>();
  const waited = (cause: PlanStreamWaitCause) => waits.set(cause, (waits.get(cause) ?? 0) + 1);
  for (const [order, root] of roots.entries()) {
    const decided = await decideRoot(ctx, root, input);
    if (!decided.ok) return decided;
    if (decided.answer.decision === 'wait') {
      if (decided.answer.cause === 'stream_closed') exhaustedRoots.add(root.nodeId);
      waited(decided.answer.cause);
      continue;
    }
    candidates.push({
      ...decided,
      root: { nodeId: root.nodeId, title: root.title, position: root.position },
      order,
    });
  }
  candidates.sort((a, b) => boardRank(a.answer) - boardRank(b.answer) || a.order - b.order);

  const decisions: PlanBoardDecision[] = [];
  let deferred = 0;
  for (const candidate of candidates) {
    if (decisions.length >= input.decisions) {
      deferred += 1;
      continue;
    }
    if (candidate.claim && !(await claimStreamState(ctx, candidate.claim.key))) {
      waited('claimed');
      continue;
    }
    if (
      candidate.ask &&
      !(await claimAsk(
        ctx,
        candidate.ask.node,
        candidate.ask.record,
        candidate.answer.decision === 'ask' && candidate.answer.update !== undefined,
      ))
    ) {
      waited('claimed');
      continue;
    }
    decisions.push({ root: candidate.root, answer: candidate.answer });
  }

  let proposal: PlanBoardNext['propose'];
  if (
    candidates.every((candidate) => candidate.answer.decision === 'ask') &&
    !open.truncated &&
    roots[0]
  ) {
    for (const candidate of roots) {
      if (!exhaustedRoots.has(candidate.nodeId)) continue;
      const root = await ctx.store.find(ctx.spaceId, candidate.nodeId);
      const history = await readRootHistory(ctx, candidate.nodeId);
      const declined = history.nodes.some(
        (node) =>
          node.status === 'dropped' &&
          node.noteHead?.startsWith(PLAN_NODE_PROPOSED_HEAD) &&
          !isFindingsCarrier(node.noteHead),
      );
      if (
        root?.status !== 'active' ||
        history.truncated !== undefined ||
        history.nodes.some((node) => node.status === 'blocked' || node.status === 'waiting') ||
        declined
      )
        continue;
      proposal = {
        parentId: root.nodeId,
        reason:
          'No approved work is actionable; propose at most one next step toward this open root for operator approval.',
        title: root.title,
        goal: root.goal,
        criteria: root.criteria,
      };
      break;
    }
  }

  return {
    ok: true,
    output: {
      scope: 'board',
      decisions,
      deferred,
      waits: [...waits].map(([cause, count]) => ({ cause, roots: count })),
      roots: roots.length,
      ...(proposal ? { propose: proposal } : {}),
      ...(open.truncated !== undefined ? { truncated: open.truncated } : {}),
    },
  };
}
