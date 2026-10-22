/**
 * A stream continues on a schedule (Plan 322 P2b). A firing is a Helmsman run
 * told only to continue the stream under a root; `plan.node.next` is what it
 * asks first, and this is the one authority over the answer. The decision is
 * read from records — the active node, its runs, its links, the space's
 * attention items and its pull request as GitHub answers — by rules, so no
 * firing decides by how its prompt reads. It writes nothing to the plan and
 * starts nothing — the firing acts on the decision — except that a `continue`
 * claims the state it was decided on, so two firings that read alike cannot
 * both commission.
 */
import type { Redis } from 'ioredis';
import {
  isClosedPlanNodeStatus,
  OPEN_PLAN_NODE_STATUSES,
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_NODE_RUNS_LIMIT,
  PLAN_STREAM_COMMISSION_SLUG,
  PLAN_STREAM_PUBLICATION_SLUG,
  type PlanNode,
  type PlanNodeLink,
  type PlanNodeListTruncation,
  type PlanNodeNextInput,
  type PlanNodeNextOutput,
  type PlanNodeRun,
  type PlanNodeSummary,
  type PlanStreamBriefNode,
  type PlanStreamNode,
  type PlanStreamPullRequestAnswer,
  type PlanStreamRetry,
  type PlanStreamStopCause,
  type PlanStreamWaitCause,
} from '@aflow/schemas';
import {
  getPlanNode,
  PLAN_TREE_WALK_BOUNDS,
  type PlanOpResult,
  type PlanReadContext,
} from './operations.js';
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
}

/** What a publication that completed promoted. */
export interface PlanPublicationOutcome {
  prUrl?: string;
  afterReview?: string;
  pushDecision?: string;
  reviewRunId?: string;
}

/** The reads a firing makes past the plan's own tables. */
export interface PlanStreamReads {
  /** The node's own commissions and publications, newest first, at most `limit`. */
  roundsOf(spaceId: string, nodeId: string, limit: number): Promise<PlanStreamRun[]>;
  /** What a completed publication promoted; null where it cannot be read. */
  publicationOutcome(spaceId: string, runId: string): Promise<PlanPublicationOutcome | null>;
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
  attempts: number;
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

function wait(
  cause: PlanStreamWaitCause,
  reason: string,
  node?: PlanNode | PlanNodeSummary,
): PlanNodeNextOutput {
  return { decision: 'wait', cause, reason, ...(node ? { node: streamNode(node) } : {}) };
}

function blockedNote(node: PlanNode, why: string): string {
  const head = `Blocked: ${why}`;
  const note = node.note !== undefined ? `${head}\n${node.note}` : head;
  return note.slice(0, PLAN_NODE_PROSE_MAX_CHARS);
}

function stop(node: PlanNode, cause: PlanStreamStopCause, why: string): PlanNodeNextOutput {
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
  | { kind: 'decided'; output: PlanNodeNextOutput };

function answerLatestRound(facts: PlanStreamFacts): RoundAnswer {
  const { node } = facts;
  const latest = latestRoundSinceWrite(facts.rounds, node.updatedAt);
  if (!latest) return { kind: 'fresh' };
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
        return {
          kind: 'decided',
          output: wait(
            'awaiting_publication',
            `The ${ran} completed and no publication of it has started; the conversation that started it publishes it.`,
            node,
          ),
        };
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

function latestRoundSinceWrite(
  rounds: readonly PlanStreamRun[],
  updatedAt: string,
): PlanStreamRun | undefined {
  return startedAfter(rounds, updatedAt)[0];
}

/**
 * The firing's decision on the active node, the first rule that holds
 * deciding: a blocked node is the person's, whatever its pull request says;
 * `wait` while its own work is in flight, or the read of the nodes under it
 * stopped at a bound before it could show none is; a merge of its newest pull request
 * nobody has acted on is recorded next; then `wait` while that pull request
 * is open or a read failed; `stop` where its pull request was closed unmerged, its push was
 * declined or its attempts are spent; `continue` where its next step is the
 * work or its last round failed within the budget. Anything else is `wait`.
 */
export function decideStreamFiring(facts: PlanStreamFacts): PlanNodeNextOutput {
  const { node } = facts;
  if (node.status === 'blocked') {
    return wait('blocked', `"${node.title}" is blocked, waiting on a person.`, node);
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
          link: {
            nodeId: node.nodeId,
            kind: 'merge',
            ref: link.ref,
            label: `merged ${answer.mergeCommitSha ? `as ${answer.mergeCommitSha} ` : ''}at ${mergedAt}`,
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
        : `No commission of "${node.title}" has started since it was last written; its next step is the work.`,
    node: briefNode(node),
    ...(round.kind === 'retry' ? { retry: round.retry } : {}),
    attemptsUsed: used,
    attempts: facts.attempts,
  };
}

// ============================================================================
// plan.node.next
// ============================================================================

/** Read what the decision turns on, and decide. */
export async function nextInPlanStream(
  ctx: PlanStreamContext,
  input: PlanNodeNextInput,
): Promise<PlanOpResult<{ output: PlanNodeNextOutput }>> {
  const root = await ctx.store.find(ctx.spaceId, input.rootNodeId);
  if (!root) {
    return {
      ok: false,
      code: 'PLAN_NODE_NOT_FOUND',
      message: `No plan node "${input.rootNodeId}" in this space to continue as a stream. The schedule names a node that is gone: the operator removes or changes it.`,
      details: { nodeId: input.rootNodeId },
    };
  }
  const decided = (output: PlanNodeNextOutput) => ({ ok: true as const, output });
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

  // Every status: a run serving a node closed under the active one is still in
  // flight. Where the walk's bounds cut it short, the runs below are unread, and
  // the decision is told so rather than shown fewer runs.
  const subtree = await ctx.store.walk(ctx.spaceId, {
    rootId: active.nodeId,
    ...PLAN_TREE_WALK_BOUNDS,
  });
  const servedNodeIds = subtree.nodes.map((n) => n.nodeId);
  const [rounds, inFlight, pausedItems] = await Promise.all([
    ctx.reads.roundsOf(ctx.spaceId, active.nodeId, PLAN_STREAM_ROUNDS_LIMIT),
    ctx.store.listRunsServing(ctx.spaceId, servedNodeIds, PLAN_NODE_RUNS_LIMIT),
    ctx.reads.pausedItemsServing(ctx.spaceId, servedNodeIds),
  ]);
  const latest = latestRoundSinceWrite(rounds, opened.node.updatedAt);
  const publication =
    latest?.slug === PLAN_STREAM_PUBLICATION_SLUG && latest.status === 'completed'
      ? await ctx.reads.publicationOutcome(ctx.spaceId, latest.runId)
      : undefined;
  // Read by kind and by key, never from `opened.links`, a page that a node with
  // many links would carry these records past.
  const pullRequestLink =
    (await ctx.store.newestLink(ctx.spaceId, active.nodeId, 'pull_request')) ?? undefined;
  const mergeJudged =
    pullRequestLink !== undefined &&
    (await ctx.store.findLink(ctx.spaceId, active.nodeId, 'merge', pullRequestLink.ref)) !== null;

  const decision = decideStreamFiring({
    node: opened.node,
    mergeJudged,
    inFlight: inFlight.runs,
    ...(subtree.truncated ? { inFlightUnread: subtree.truncated } : {}),
    pausedItems,
    ...(pullRequestLink ? { pullRequestLink } : {}),
    ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
    rounds,
    ...(publication !== undefined ? { publication } : {}),
    attempts: input.attempts,
  });
  if (decision.decision !== 'continue') return decided(decision);
  const claim = streamClaimKey(ctx, opened.node, rounds, pullRequestLink);
  if (await claimStreamState(ctx, claim)) return decided(decision);
  return decided(
    wait(
      'claimed',
      `Another firing decided to continue "${opened.node.title}" on the state this one read, and is commissioning it.`,
      opened.node,
    ),
  );
}
