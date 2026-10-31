import { readFileSync } from 'node:fs';
import * as runtimeLogger from '../logger.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  getOperation,
  PLAN_NODE_PROSE_MAX_CHARS,
  PlanNodeSchema,
  PLAN_NODE_LINKS_LIMIT,
  PLAN_NODE_NEXT_OPERATION_ID,
  PLAN_STREAM_ATTEMPTS_DEFAULT,
  PLAN_STREAM_COMMISSION_SLUG,
  PLAN_STREAM_PUBLICATION_SLUG,
  PLAN_TREE_DEPTH_LIMIT,
  PLAN_TREE_WALK_NODE_LIMIT,
  PlanNodeNextInputSchema,
  PlanNodeNextOutputSchema,
  type PlanNode,
  type PlanNodeCreateInput,
  type PlanBoardNext,
  type PlanStreamAnswer,
  type PlanStreamPullRequestAnswer,
} from '@aflow/schemas';
import {
  createPlanNode,
  getPlanNode,
  linkEndedRun,
  linkPlanNode,
  openPlanNode,
  revisePlanNode,
  updatePlanNode,
  type PlanWriteContext,
} from '../plan/operations.js';
import {
  findActiveStreamNode,
  mergeNoteHead,
  nextInPlanStream,
  nextOnPlanBoard,
  type PlanCommissionOutcome,
  type PlanPublicationOutcome,
  type PlanStreamReads,
} from '../plan/stream.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';
import { carrierNode } from '../plan/carrier.js';
import { planAsk, listWaitingNodes, askedKey } from '../plan/asks.js';
import { restrictedPlanWriteAuthority } from '../plan/writeAuthority.js';

vi.mock('../logger.js', () => ({ logCyberneticError: vi.fn() }));

const TENANT = 'a0000000-0000-4000-8000-000000000322';
const SPACE = '5e1d0000-0000-4000-8000-000000000322';
const PR = 'https://github.com/aflowai/aflow/pull/160';
const MERGE_SHA = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';

let store: InMemoryPlanNodeStore;
let redis: RedisType;
let outcomes: Map<string, PlanPublicationOutcome | null>;
let commissions: Map<string, PlanCommissionOutcome | null>;
/** A publication run → the commission run it names as `commission`. */
let publishes: Map<string, string>;
/** A run → what it cost, in cents. */
let costs: Map<string, number>;
let failures: Map<string, string>;
let pausedItemRuns: string[];
let lastStamp: number;
let runSeq: number;
let operatorCommissions: Set<string>;

/** The reads as the database answers them, over the fake store's runs. */
function reads(): PlanStreamReads {
  return {
    roundsOf: (spaceId, nodeId, limit) =>
      Promise.resolve(
        store.runs
          .filter(
            (r) =>
              r.spaceId === spaceId &&
              r.nodeId === nodeId &&
              [PLAN_STREAM_COMMISSION_SLUG, PLAN_STREAM_PUBLICATION_SLUG].includes(r.slug),
          )
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, limit)
          .map((r) => ({
            runId: r.runId,
            slug: r.slug,
            status: r.status,
            startedAt: r.startedAt,
            ...(operatorCommissions.has(r.runId) ? {} : { wakeSessionId: 'wake-1' }),
            ...(failures.has(r.runId) ? { failure: failures.get(r.runId)! } : {}),
          })),
      ),
    publicationOutcome: (_spaceId, runId) => Promise.resolve(outcomes.get(runId) ?? null),
    commissionOutcome: (_spaceId, runId) => Promise.resolve(commissions.get(runId) ?? null),
    publicationsOf: (_spaceId, commissionRunId) =>
      Promise.resolve(
        store.runs
          .filter((r) => publishes.get(r.runId) === commissionRunId)
          .map((r) => ({ runId: r.runId, slug: r.slug, status: r.status, startedAt: r.startedAt })),
      ),
    spendOf: (_spaceId, nodeId) => {
      // The window opens where the open write stamped the node, as plan_nodes.opened_at does.
      const since = store.openedAt.get(nodeId)?.getTime();
      const served = store.runs
        .filter(
          (r) => r.nodeId === nodeId && (since === undefined || Date.parse(r.startedAt) > since),
        )
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return Promise.resolve({
        cents: served.reduce((sum, r) => sum + (costs.get(r.runId) ?? 0), 0),
        runIds: served.map((r) => r.runId),
        wakeSessionIds: [],
      });
    },
    pausedItemsServing: (_spaceId, nodeIds, rootId) =>
      Promise.resolve(
        pausedItemRuns.filter((runId) =>
          store.runs.some((r) => {
            if (r.runId !== runId) return false;
            if (rootId === undefined) return nodeIds.includes(r.nodeId);
            let node = store.nodes.get(r.nodeId);
            while (node) {
              if (node.nodeId === rootId) return true;
              node = node.parentId ? store.nodes.get(node.parentId) : undefined;
            }
            return false;
          }),
        ).length,
      ),
  };
}

function session(): PlanWriteContext {
  return {
    store,
    redis,
    tenantId: TENANT,
    spaceId: SPACE,
    createdBy: 'operator',
    actorKind: 'human',
  };
}

/** A time after everything the store has written, and after the last one handed out. */
function stamp(): string {
  const written = [
    ...[...store.nodes.values()].map((n) => Date.parse(n.updatedAt)),
    ...store.links.map((l) => Date.parse(l.createdAt)),
  ];
  lastStamp = Math.max(lastStamp, ...written) + 10;
  return new Date(lastStamp).toISOString();
}

async function created(input: Partial<PlanNodeCreateInput> = {}): Promise<PlanNode> {
  const result = await createPlanNode(session(), {
    kind: 'execute',
    title: 'Plan 322 P2b · the stream wakes itself',
    goal: 'A stream continues on a schedule.',
    criteria: 'Two firings observed.',
    ...input,
  });
  if (!result.ok) throw new Error(result.message);
  return result.node;
}

async function current(nodeId: string): Promise<PlanNode> {
  const node = await store.find(SPACE, nodeId);
  if (!node) throw new Error(`no node ${nodeId}`);
  return node;
}

async function write(nodeId: string, change: Record<string, unknown>): Promise<PlanNode> {
  const node = await current(nodeId);
  const result = await updatePlanNode(session(), {
    nodeId,
    expectedRevision: node.revision,
    ...change,
  });
  if (!result.ok) throw new Error(result.message);
  return result.node;
}

/** A run serving `node`, started now; one that has ended links itself as `completeRun` does. */
async function run(
  node: PlanNode,
  slug: string,
  status: string,
  opts: {
    failure?: string;
    outcome?: PlanPublicationOutcome | null;
    commission?: PlanCommissionOutcome | null;
    cents?: number;
  } = {},
): Promise<string> {
  runSeq += 1;
  const runId = `${slug}-${String(runSeq)}`;
  store.runs.push({ runId, slug, status, nodeId: node.nodeId, spaceId: SPACE, startedAt: stamp() });
  if (opts.failure !== undefined) failures.set(runId, opts.failure);
  if (opts.outcome !== undefined) outcomes.set(runId, opts.outcome);
  if (opts.cents !== undefined) costs.set(runId, opts.cents);
  if (slug === PLAN_STREAM_COMMISSION_SLUG) {
    commissions.set(
      runId,
      opts.commission !== undefined
        ? opts.commission
        : { patchRef: `payload:patch-${runId}`, baseSha: 'abc1234', bindingId: 'hb_aflow' },
    );
  }
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    await linkEndedRun(session(), {
      nodeId: node.nodeId,
      runId,
      slug,
      status,
      ...(opts.outcome?.prUrl !== undefined ? { pullRequestUrl: opts.outcome.prUrl } : {}),
    });
  }
  return runId;
}

/** A run that was in flight ends, as `completeRun` records it. */
function ends(runId: string, status: string): void {
  const held = store.runs.find((r) => r.runId === runId);
  if (!held) throw new Error(`no run ${runId}`);
  held.status = status;
}

function streamContext(holder = 'firing-a') {
  return { store, spaceId: SPACE, reads: reads(), redis, tenantId: TENANT, holder };
}

async function next(
  rootNodeId: string,
  extra: { attempts?: number; pullRequest?: PlanStreamPullRequestAnswer } = {},
  holder?: string,
): Promise<PlanStreamAnswer> {
  const input = PlanNodeNextInputSchema.parse({ rootNodeId, ...extra });
  const result = await nextInPlanStream(streamContext(holder), rootNodeId, input);
  if (!result.ok) throw new Error(result.message);
  expect(PlanNodeNextOutputSchema.safeParse(result.output).success).toBe(true);
  return result.output;
}

/** A firing that reads the pull request when asked, as GitHub answers it. */
async function fire(
  rootNodeId: string,
  github?: (url: string) => PlanStreamPullRequestAnswer,
  attempts?: number,
): Promise<PlanStreamAnswer> {
  const first = await next(rootNodeId, attempts !== undefined ? { attempts } : {});
  if (first.decision !== 'read_pull_request') return first;
  if (!github) throw new Error(`the firing asked to read ${first.pullRequest.url}`);
  return next(rootNodeId, {
    pullRequest: github(first.pullRequest.url),
    ...(attempts !== undefined ? { attempts } : {}),
  });
}

function open(url: string): PlanStreamPullRequestAnswer {
  return { url, read: 'ok', state: 'open', merged: false };
}

function merged(url: string, mergedAt: string): PlanStreamPullRequestAnswer {
  return {
    url,
    read: 'ok',
    state: 'closed',
    merged: true,
    mergedAt,
    closedAt: mergedAt,
    mergeCommitSha: MERGE_SHA,
  };
}

function closedUnmerged(url: string, closedAt: string): PlanStreamPullRequestAnswer {
  return { url, read: 'ok', state: 'closed', merged: false, closedAt };
}

/** A root with two steps under it, the stream's first active node being the first. */
async function stream(): Promise<{ root: PlanNode; first: PlanNode; second: PlanNode }> {
  const root = await created({ title: 'Plan 322' });
  const first = await created({ parentId: root.nodeId, title: 'P2b' });
  const second = await created({ parentId: root.nodeId, title: 'P3' });
  return { root, first, second };
}

/** A round that opened the node's pull request, and the time GitHub merged it. */
async function publishedRound(node: PlanNode): Promise<string> {
  await run(node, PLAN_STREAM_COMMISSION_SLUG, 'completed');
  await run(node, PLAN_STREAM_PUBLICATION_SLUG, 'completed', {
    outcome: { prUrl: PR, afterReview: 'publish_as_is', pushDecision: 'push' },
  });
  return stamp();
}

beforeEach(async () => {
  store = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
  outcomes = new Map();
  commissions = new Map();
  publishes = new Map();
  operatorCommissions = new Set();
  costs = new Map();
  failures = new Map();
  pausedItemRuns = [];
  lastStamp = 0;
  runSeq = 0;
});

describe('the firing message and its input', () => {
  it('defaults the attempt budget, and a merged answer must carry its times', () => {
    const root = '5e1d0000-0000-4000-8000-0000000000aa';
    expect(PlanNodeNextInputSchema.parse({ rootNodeId: root }).attempts).toBe(
      PLAN_STREAM_ATTEMPTS_DEFAULT,
    );
    const missing = PlanNodeNextInputSchema.safeParse({
      rootNodeId: root,
      pullRequest: { url: PR, read: 'ok', state: 'closed', merged: true },
    });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((i) => i.path.join('.'))).toEqual(
      expect.arrayContaining(['pullRequest.mergedAt', 'pullRequest.closedAt']),
    );
  });
});

describe('findActiveStreamNode', () => {
  it('walks into the first open child by position, and a parent whose children are closed is its own', async () => {
    const { root, first, second } = await stream();
    const walk = async () =>
      findActiveStreamNode(
        (await store.walk(SPACE, { rootId: root.nodeId, maxDepth: 64, maxNodes: 2000 })).nodes,
        root.nodeId,
      );
    expect((await walk())?.nodeId).toBe(first.nodeId);
    await write(first.nodeId, { status: 'done', outcome: 'Met.' });
    expect((await walk())?.nodeId).toBe(second.nodeId);
    await write(second.nodeId, { status: 'dropped', outcome: 'Not needed.' });
    expect((await walk())?.nodeId).toBe(root.nodeId);
    await write(root.nodeId, { status: 'done', outcome: 'Met.' });
    expect(await walk()).toBeNull();
  });

  it('stops at a blocked node, whatever lies under or after it', async () => {
    const { root, first } = await stream();
    await created({ parentId: first.nodeId, title: 'P2b.a' });
    await write(first.nodeId, { status: 'blocked' });
    const walked = await store.walk(SPACE, { rootId: root.nodeId, maxDepth: 64, maxNodes: 2000 });
    expect(findActiveStreamNode(walked.nodes, root.nodeId)?.nodeId).toBe(first.nodeId);
  });

  it('stops at a waiting node too, and the firing decides it by the rules an active one takes', async () => {
    const { root, first } = await stream();
    await created({ parentId: first.nodeId, title: 'P2b.a' });
    await write(first.nodeId, { status: 'waiting' });
    const walked = await store.walk(SPACE, { rootId: root.nodeId, maxDepth: 64, maxNodes: 2000 });
    expect(findActiveStreamNode(walked.nodes, root.nodeId)?.nodeId).toBe(first.nodeId);
    expect(await fire(root.nodeId)).toMatchObject({
      decision: 'continue',
      node: { nodeId: first.nodeId },
    });
  });
});

describe('plan.node.next — wait', () => {
  it('waits while a commission of the node is in flight, and names it', async () => {
    const { root, first } = await stream();
    const commission = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'running');
    const decided = await fire(root.nodeId);
    expect(decided).toMatchObject({
      decision: 'wait',
      cause: 'in_flight',
      node: { nodeId: first.nodeId },
    });
    expect(decided.reason).toContain(commission);
  });

  it('waits while a run serving a node closed under the active one is in flight', async () => {
    const { root, first } = await stream();
    const step = await created({ parentId: first.nodeId, title: 'P2b.a' });
    const descendant = await run(step, PLAN_STREAM_COMMISSION_SLUG, 'running');
    await write(step.nodeId, { status: 'done', outcome: 'Met.' });
    const decided = await fire(root.nodeId);
    expect(decided).toMatchObject({
      decision: 'wait',
      cause: 'in_flight',
      node: { nodeId: first.nodeId },
    });
    expect(decided.reason).toContain(descendant);
  });

  it('a run still in flight below the walk’s depth bound holds the firing at wait, not continue', async () => {
    const { root, first } = await stream();
    let parent = first;
    for (let depth = 1; depth <= PLAN_TREE_DEPTH_LIMIT + 1; depth++) {
      parent = store.seed(SPACE, {
        parentId: parent.nodeId,
        title: `closed step ${String(depth)}`,
        status: 'done',
        outcome: 'Met.',
      });
    }
    await run(parent, PLAN_STREAM_COMMISSION_SLUG, 'running');
    expect(await fire(root.nodeId)).toMatchObject({
      decision: 'wait',
      cause: 'read_failed',
      node: { nodeId: first.nodeId },
    });
  });

  it('a run still in flight past the walk’s node bound holds the firing at wait, not continue', async () => {
    const { root, first } = await stream();
    let last = first;
    for (let i = 0; i <= PLAN_TREE_WALK_NODE_LIMIT; i++) {
      last = store.seed(SPACE, {
        parentId: first.nodeId,
        title: `closed step ${String(i)}`,
        status: 'done',
        outcome: 'Met.',
        position: i,
      });
    }
    await run(last, PLAN_STREAM_COMMISSION_SLUG, 'running');
    expect(await fire(root.nodeId)).toMatchObject({
      decision: 'wait',
      cause: 'read_failed',
      node: { nodeId: first.nodeId },
    });
  });

  it('waits while a publication is paused at its push approval, read from the attention items too', async () => {
    const { root, first } = await stream();
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed');
    const publication = await run(first, PLAN_STREAM_PUBLICATION_SLUG, 'paused');
    pausedItemRuns.push(publication);
    expect(await fire(root.nodeId)).toMatchObject({ decision: 'wait', cause: 'in_flight' });

    // The attention item alone holds the firing back where the run's status lags it.
    ends(publication, 'completed');
    outcomes.set(publication, { pushDecision: 'ask' });
    expect(await fire(root.nodeId)).toMatchObject({ decision: 'wait', cause: 'in_flight' });
  });

  it('waits while the node’s pull request is open, and asks GitHub before deciding', async () => {
    const { root, first } = await stream();
    await publishedRound(first);
    const asked = await next(root.nodeId);
    expect(asked).toMatchObject({
      decision: 'read_pull_request',
      pullRequest: { url: PR, owner: 'aflowai', repo: 'aflow', number: 160 },
    });
    expect(await fire(root.nodeId, open)).toMatchObject({
      decision: 'wait',
      cause: 'pull_request_open',
    });
  });

  it('waits where the pull request could not be read, or the answer is for another', async () => {
    const { root, first } = await stream();
    await publishedRound(first);
    expect(await next(root.nodeId, { pullRequest: { url: PR, read: 'failed' } })).toMatchObject({
      decision: 'wait',
      cause: 'read_failed',
    });
    const other = 'https://github.com/aflowai/aflow/pull/1';
    expect(await next(root.nodeId, { pullRequest: open(other) })).toMatchObject({
      decision: 'read_pull_request',
      pullRequest: { url: PR },
    });
  });

  it('waits on a closed root, writing nothing', async () => {
    const { root } = await stream();
    await write(root.nodeId, { status: 'done', outcome: 'Met.' });
    const revisions = [...store.nodes.values()].map((n) => n.revision);
    expect(await fire(root.nodeId)).toMatchObject({ decision: 'wait', cause: 'stream_closed' });
    expect([...store.nodes.values()].map((n) => n.revision)).toEqual(revisions);
  });

  it('waits where what a completed commission made cannot be read', async () => {
    const { root, first } = await stream();
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed', { commission: null });
    expect(await fire(root.nodeId)).toMatchObject({ decision: 'wait', cause: 'read_failed' });
  });

  it('waits on a decision for the operator, commissions nothing, and passes it once it is answered', async () => {
    const root = await created({ title: 'Plan 322' });
    const decision = await created({
      parentId: root.nodeId,
      kind: 'decide',
      title: 'Where the decide answer is recorded',
    });
    const after = await created({ parentId: root.nodeId, title: 'P3.3' });
    const revisions = [...store.nodes.values()].map((n) => n.revision);

    expect(await fire(root.nodeId)).toMatchObject({
      decision: 'wait',
      cause: 'awaiting_decision',
      node: { nodeId: decision.nodeId },
    });
    expect([...store.nodes.values()].map((n) => n.revision)).toEqual(revisions);

    await write(decision.nodeId, { status: 'done', outcome: 'In the node’s outcome.' });
    expect(await fire(root.nodeId)).toMatchObject({
      decision: 'continue',
      node: { nodeId: after.nodeId },
    });
  });

  it('works through the open steps under a decision first, then waits on the decision', async () => {
    const root = await created({ title: 'Plan 322' });
    const decision = await created({ parentId: root.nodeId, kind: 'decide', title: 'Choose' });
    const inquiry = await created({
      parentId: decision.nodeId,
      kind: 'investigate',
      title: 'What each choice costs',
    });

    expect(await fire(root.nodeId)).toMatchObject({
      decision: 'continue',
      node: { nodeId: inquiry.nodeId },
    });
    await write(inquiry.nodeId, { status: 'done', outcome: 'Costs compared.' });
    expect(await fire(root.nodeId)).toMatchObject({
      decision: 'wait',
      cause: 'awaiting_decision',
      node: { nodeId: decision.nodeId },
    });
  });

  it('refuses a root that is not in the space', async () => {
    const missing = '5e1d0000-0000-4000-8000-00000000dead';
    const result = await nextInPlanStream(
      streamContext(),
      missing,
      PlanNodeNextInputSchema.parse({ rootNodeId: missing }),
    );
    expect(result).toMatchObject({ ok: false, code: 'PLAN_NODE_NOT_FOUND' });
  });
});

describe('plan.node.next — continue', () => {
  it('commissions a node with no commission since its last write, briefed from its goal and criteria', async () => {
    const { root, first } = await stream();
    expect(await fire(root.nodeId)).toMatchObject({
      decision: 'continue',
      node: { nodeId: first.nodeId, goal: first.goal, criteria: first.criteria },
      attemptsUsed: 0,
    });
  });

  it('two overlapping firings with no work in flight: at most one continues to commission', async () => {
    const { root, first } = await stream();
    const decisions = await Promise.all([
      next(root.nodeId, {}, 'firing-a'),
      next(root.nodeId, {}, 'firing-b'),
    ]);
    expect(decisions.filter((d) => d.decision === 'continue')).toHaveLength(1);
    expect(decisions.find((d) => d.decision !== 'continue')).toMatchObject({
      decision: 'wait',
      cause: 'claimed',
      node: { nodeId: first.nodeId },
    });

    // The firing that took the state may ask again; the other still waits.
    const winner = decisions[0]!.decision === 'continue' ? 'firing-a' : 'firing-b';
    const loser = winner === 'firing-a' ? 'firing-b' : 'firing-a';
    expect(await next(root.nodeId, {}, winner)).toMatchObject({ decision: 'continue' });
    expect(await next(root.nodeId, {}, loser)).toMatchObject({
      decision: 'wait',
      cause: 'claimed',
    });

    // Once its commission runs, the round holds every firing back by itself.
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'running');
    expect(await next(root.nodeId, {}, loser)).toMatchObject({
      decision: 'wait',
      cause: 'in_flight',
    });
  });

  it('a claim is on the state read: a round ended since is another firing’s to continue', async () => {
    const { root, first } = await stream();
    expect(await next(root.nodeId, {}, 'firing-a')).toMatchObject({ decision: 'continue' });
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'failed');
    expect(await next(root.nodeId, {}, 'firing-b')).toMatchObject({
      decision: 'continue',
      retry: { cause: 'commission_failed' },
    });
  });

  it('re-commissions a publication ended at fix_before_merge, with the review run’s id in the brief', async () => {
    const { root, first } = await stream();
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed');
    const publication = await run(first, PLAN_STREAM_PUBLICATION_SLUG, 'completed', {
      outcome: {
        afterReview: 'fix_before_merge',
        pushDecision: 'keep_local',
        reviewRunId: 'review-7',
      },
    });
    expect(await fire(root.nodeId)).toMatchObject({
      decision: 'continue',
      retry: { cause: 'fix_before_merge', runId: publication, reviewRunId: 'review-7' },
      attemptsUsed: 1,
    });
  });

  it('waits where a completed publication’s outcome cannot be read', async () => {
    const { root, first } = await stream();
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed');
    await run(first, PLAN_STREAM_PUBLICATION_SLUG, 'completed', { outcome: null });
    expect(await fire(root.nodeId)).toMatchObject({ decision: 'wait', cause: 'read_failed' });
  });
});

describe('plan.node.next — the attempt budget', () => {
  it('re-commissions a failed commission up to the budget, and the firing after it stops', async () => {
    const { root, first } = await stream();
    const attempts = 2;
    for (let round = 1; round <= attempts; round++) {
      const failed = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'failed', {
        failure: `round ${String(round)} broke`,
      });
      expect(await fire(root.nodeId, undefined, attempts)).toMatchObject({
        decision: 'continue',
        retry: {
          cause: 'commission_failed',
          runId: failed,
          failure: `round ${String(round)} broke`,
        },
        attemptsUsed: round,
      });
    }
    const last = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'failed');
    const stopped = await fire(root.nodeId, undefined, attempts);
    expect(stopped).toMatchObject({
      decision: 'stop',
      cause: 'attempts_spent',
      update: { nodeId: first.nodeId, status: 'blocked' },
    });
    if (stopped.decision !== 'stop') throw new Error('expected stop');
    expect(stopped.update.note).toContain(last);
  });

  it('a write to the node restores the budget', async () => {
    const { root, first } = await stream();
    for (let round = 0; round < 3; round++) {
      await run(first, PLAN_STREAM_COMMISSION_SLUG, 'failed');
    }
    expect(await fire(root.nodeId, undefined, 2)).toMatchObject({ decision: 'stop' });
    await write(first.nodeId, { note: 'next: build it with the smaller brief' });
    expect(await fire(root.nodeId, undefined, 2)).toMatchObject({
      decision: 'continue',
      attemptsUsed: 0,
    });
  });
});

describe('plan.node.next — stop', () => {
  it('stops on a declined push with no commission, and the stop’s write holds the node blocked', async () => {
    const { root, first } = await stream();
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed');
    await run(first, PLAN_STREAM_PUBLICATION_SLUG, 'completed', {
      outcome: { pushDecision: 'ask' },
    });
    const stopped = await fire(root.nodeId);
    expect(stopped).toMatchObject({ decision: 'stop', cause: 'publication_denied' });
    if (stopped.decision !== 'stop') throw new Error('expected stop');
    const written = await updatePlanNode(session(), stopped.update);
    expect(written).toMatchObject({ ok: true, node: { status: 'blocked' } });
    expect(await fire(root.nodeId)).toMatchObject({ decision: 'wait', cause: 'blocked' });
  });

  it('stops where the pull request was closed unmerged, naming it, and holds the stream at the blocked node', async () => {
    const { root, first, second } = await stream();
    await publishedRound(first);
    const closedAt = stamp();
    const stopped = await fire(root.nodeId, (url) => closedUnmerged(url, closedAt));
    expect(stopped).toMatchObject({ decision: 'stop', cause: 'pull_request_closed' });
    if (stopped.decision !== 'stop') throw new Error('expected stop');
    expect(stopped.update.note).toContain(PR);
    await updatePlanNode(session(), stopped.update);

    // Every later firing waits on the blocked node; its next sibling is not started.
    for (let firing = 0; firing < 2; firing++) {
      expect(await fire(root.nodeId, (url) => closedUnmerged(url, closedAt))).toMatchObject({
        decision: 'wait',
        cause: 'blocked',
        node: { nodeId: first.nodeId },
      });
    }
    expect(store.runs.filter((r) => r.nodeId === second.nodeId)).toHaveLength(0);

    // A person who sets the node active again has said what the work is now.
    await write(first.nodeId, { status: 'active', note: 'next: start again on a fresh branch' });
    expect(await fire(root.nodeId, (url) => closedUnmerged(url, closedAt))).toMatchObject({
      decision: 'continue',
      node: { nodeId: first.nodeId },
    });
  });
});

describe('plan.node.next — a merge', () => {
  it('a blocked node waits on its merged pull request and records nothing: blocked is read before the merge', async () => {
    const { root, first } = await stream();
    const mergedAt = await publishedRound(first);
    await write(first.nodeId, { status: 'blocked', note: 'held by the operator' });
    const before = await current(first.nodeId);
    expect(await fire(root.nodeId, (url) => merged(url, mergedAt))).toMatchObject({
      decision: 'wait',
      cause: 'blocked',
      node: { nodeId: first.nodeId },
    });
    expect((await current(first.nodeId)).revision).toBe(before.revision);
    expect(store.links.filter((l) => l.kind === 'merge')).toHaveLength(0);
  });

  it('waits on a merged pull request while the node’s own commission or publication is in flight', async () => {
    for (const slug of [PLAN_STREAM_COMMISSION_SLUG, PLAN_STREAM_PUBLICATION_SLUG]) {
      store = new InMemoryPlanNodeStore();
      const { root, first } = await stream();
      const mergedAt = await publishedRound(first);
      await run(first, slug, slug === PLAN_STREAM_COMMISSION_SLUG ? 'running' : 'paused');
      const decided = await fire(root.nodeId, (url) => merged(url, mergedAt));
      expect(decided, slug).toMatchObject({
        decision: 'wait',
        cause: 'in_flight',
        node: { nodeId: first.nodeId },
      });
      expect(
        store.links.filter((l) => l.kind === 'merge'),
        slug,
      ).toHaveLength(0);
    }
  });

  it('reads the node’s pull request and merge records past a page of its other links', async () => {
    const { root, first } = await stream();
    const mergedAt = await publishedRound(first);
    const github = (url: string) => merged(url, mergedAt);
    const record = await fire(root.nodeId, github);
    if (record.decision !== 'record_merge') throw new Error('expected record_merge');
    await write(first.nodeId, { note: `${record.noteHead}; next: the live exit` });
    await linkPlanNode(session(), record.link);
    for (let i = 0; i <= PLAN_NODE_LINKS_LIMIT; i++) {
      await linkPlanNode(session(), {
        nodeId: first.nodeId,
        kind: 'finding',
        ref: `F${String(i)}`,
      });
    }
    const page = await getPlanNode({ store, spaceId: SPACE }, first.nodeId);
    expect(page.ok && page.links.some((l) => l.kind === 'pull_request' || l.kind === 'merge')).toBe(
      false,
    );

    expect(await next(root.nodeId)).toMatchObject({
      decision: 'read_pull_request',
      pullRequest: { url: PR },
    });
    expect(await fire(root.nodeId, github)).toMatchObject({
      decision: 'continue',
      node: { nodeId: first.nodeId },
    });
  });

  it('records a merge that met the criteria, commissions the next node, and records nothing again', async () => {
    const { root, first, second } = await stream();
    await linkPlanNode(session(), { nodeId: first.nodeId, kind: 'pull_request', ref: PR });
    const mergedAt = await publishedRound(first);
    const github = (url: string) => merged(url, mergedAt);

    const record = await fire(root.nodeId, github);
    expect(record).toMatchObject({
      decision: 'record_merge',
      node: { nodeId: first.nodeId, criteria: first.criteria },
      pullRequest: { url: PR, mergedAt, mergeCommitSha: MERGE_SHA },
    });
    await linkPlanNode(session(), { nodeId: first.nodeId, kind: 'merge', ref: PR });
    expect(
      await updatePlanNode(
        {
          ...session(),
          actorKind: 'agent',
          resident: true,
          readMergedPullRequest: async () => true,
        },
        {
          nodeId: first.nodeId,
          expectedRevision: (await current(first.nodeId)).revision,
          status: 'done',
          outcome: `Met by ${PR}, merged as ${MERGE_SHA}.`,
        },
      ),
    ).toMatchObject({ ok: true });

    // The same firing walks on and commissions the next active node.
    expect(await fire(root.nodeId, github)).toMatchObject({
      decision: 'continue',
      node: { nodeId: second.nodeId },
    });
    await run(second, PLAN_STREAM_COMMISSION_SLUG, 'running');
    const held = await fire(root.nodeId, github);
    expect(held).toMatchObject({
      decision: 'wait',
      cause: 'in_flight',
      node: { nodeId: second.nodeId },
    });
  });

  it('a merge that does not meet the criteria leaves the node active with the merge in its note, and commissions its next step once', async () => {
    const { root, first } = await stream();
    const mergedAt = await publishedRound(first);
    const github = (url: string) => merged(url, mergedAt);
    const record = await fire(root.nodeId, github);
    if (record.decision !== 'record_merge') throw new Error('expected record_merge');
    expect(record.noteHead).toBe(mergeNoteHead(PR, MERGE_SHA));
    await write(first.nodeId, { note: `${record.noteHead}; next: the live exit` });
    expect(await linkPlanNode(session(), record.link)).toMatchObject({ ok: true });

    const again = await fire(root.nodeId, github);
    expect(again).toMatchObject({
      decision: 'continue',
      node: { nodeId: first.nodeId },
      attemptsUsed: 0,
    });
    expect(again.decision === 'continue' && again.retry).toBeFalsy();

    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'running');
    expect(await fire(root.nodeId, github)).toMatchObject({ decision: 'wait', cause: 'in_flight' });
  });

  it('a note that mentions the pull request is not a judged merge: only its merge record is', async () => {
    const { root, first } = await stream();
    const mergedAt = await publishedRound(first);
    const github = (url: string) => merged(url, mergedAt);
    await write(first.nodeId, { note: `Waiting on ${PR} to merge; then the live exit.` });
    const record = await fire(root.nodeId, github);
    expect(record).toMatchObject({
      decision: 'record_merge',
      link: { nodeId: first.nodeId, kind: 'merge', ref: PR },
    });
    expect(store.links.filter((l) => l.kind === 'merge')).toHaveLength(0);
  });

  it('a person’s write after the merge does not hide it, and the node is not commissioned as though nothing merged', async () => {
    const { root, first } = await stream();
    const mergedAt = await publishedRound(first);
    await write(first.nodeId, { note: 'Looked at the review comments.' });
    expect(await fire(root.nodeId, (url) => merged(url, mergedAt))).toMatchObject({
      decision: 'record_merge',
      node: { nodeId: first.nodeId },
    });
  });

  it('two firings racing to record one merge leave one write; the other is refused on the revision', async () => {
    const { root, first } = await stream();
    const mergedAt = await publishedRound(first);
    const github = (url: string) => merged(url, mergedAt);
    const [a, b] = await Promise.all([fire(root.nodeId, github), fire(root.nodeId, github)]);
    if (a.decision !== 'record_merge' || b.decision !== 'record_merge')
      throw new Error('expected two records');
    const record = (node: { nodeId: string; revision: number }) =>
      updatePlanNode(session(), {
        nodeId: node.nodeId,
        expectedRevision: node.revision,
        status: 'done',
        outcome: `Met by ${PR}.`,
      });
    const written = await Promise.all([record(a.node), record(b.node)]);
    expect(written.filter((w) => w.ok)).toHaveLength(1);
    expect(written.find((w) => !w.ok)).toMatchObject({ ok: false, code: 'PLAN_NODE_STALE' });
    expect((await current(first.nodeId)).revision).toBe(first.revision + 1);
  });
});

// ============================================================================
// Plan 331 P1 — the resident takes the board
// ============================================================================

/** A wake across the board, as the resident's first call makes it. */
async function wake(
  extra: { decisions?: number; attempts?: number } = {},
  holder = 'wake-a',
): Promise<PlanBoardNext> {
  const result = await nextOnPlanBoard(streamContext(holder), PlanNodeNextInputSchema.parse(extra));
  if (!result.ok) throw new Error(result.message);
  expect(PlanNodeNextOutputSchema.safeParse(result.output).success).toBe(true);
  return result.output;
}

function revisions(): number[] {
  return [...store.nodes.values()].map((n) => n.revision);
}

describe('resident asking and proposing', () => {
  it.each(['agent', undefined] as const)(
    'does not attest a human read for writer %s',
    async (actorKind) => {
      const check = await created({ liveCheck: { pullRequest: PR, mergeCommitSha: MERGE_SHA } });
      const ctx = session();
      delete ctx.actorKind;
      const result = await updatePlanNode(
        { ...ctx, ...(actorKind ? { actorKind } : {}) },
        {
          nodeId: check.nodeId,
          expectedRevision: check.revision,
          status: 'active',
        },
      );
      expect(result).toMatchObject({ ok: false, code: 'PLAN_NODE_LIVE_CHECK_PERSON' });
      expect((await current(check.nodeId)).outcome).toBeUndefined();
    },
  );

  it.each(['Blocked: needs credentials', 'Proposed: next scope', 'Waiting on you: approve'])(
    'finds %s below operator prose',
    async (line) => {
      const node = await created({ note: `Operator context\n${line}\nMore context` });
      expect(planAsk({ ...node, status: 'blocked' })).toEqual({ waitsOn: line });
    },
  );

  it('reuses a wait below operator prose after a revision changes', async () => {
    const node = await created({ note: 'Operator context' });
    await write(node.nodeId, { status: 'blocked' });
    const first = planAsk(await current(node.nodeId));
    if (!first.update) throw new Error('Expected note write');
    await updatePlanNode(session(), first.update);
    await write(node.nodeId, { title: 'Revised title' });
    const next = planAsk(await current(node.nodeId));
    expect(next).toEqual({ waitsOn: first.waitsOn });
    expect((await current(node.nodeId)).note?.split('Waiting on you:')).toHaveLength(2);
    expect(await wake()).toMatchObject({
      decisions: [{ answer: { decision: 'ask', waitsOn: first.waitsOn } }],
    });
  });

  it.each(['read', 'insert'] as const)(
    'handles carrier %s failures at the correct boundary',
    async (stage) => {
      const step = await created();
      await linkPlanNode(session(), {
        nodeId: step.nodeId,
        kind: 'finding',
        ref: 'review:failure',
      });
      if (stage === 'read')
        vi.spyOn(store, 'pageLinks').mockRejectedValueOnce(new Error('carrier read'));
      else vi.spyOn(store, 'insert').mockRejectedValueOnce(new Error('carrier insert'));
      const close = updatePlanNode(session(), {
        nodeId: step.nodeId,
        expectedRevision: step.revision,
        status: 'done',
        outcome: 'Merged',
      });
      await expect(close).resolves.toMatchObject({
        ok: true,
        carrierFailure: expect.stringContaining(step.nodeId),
      });
      expect((await current(step.nodeId)).status).toBe('done');
    },
  );

  it('records a failure publishing an inserted carrier', async () => {
    const step = await created();
    await linkPlanNode(session(), { nodeId: step.nodeId, kind: 'finding', ref: 'review:publish' });
    const insert = store.insert.bind(store);
    vi.spyOn(store, 'insert').mockImplementationOnce(async (...args) => {
      const result = await insert(...args);
      vi.spyOn(redis, 'publish').mockImplementationOnce(() => {
        throw new Error('carrier publish\n' + 'raw internals '.repeat(1000));
      });
      return result;
    });
    await expect(
      updatePlanNode(session(), {
        nodeId: step.nodeId,
        expectedRevision: step.revision,
        status: 'done',
        outcome: 'Merged',
      }),
    ).resolves.toMatchObject({
      ok: true,
      carrierFailure: `Carrier failed for closed node ${step.nodeId}. Read its linked findings and propose a blocked carrier.`,
    });
    expect([...store.nodes.values()].some((node) => node.note?.startsWith('Proposed:'))).toBe(true);
  });

  it.each(['blocked', 'waiting'] as const)(
    'proposes for an exhausted root beside unrelated %s work',
    async (status) => {
      const held = await created();
      await write(held.nodeId, { status });
      if (status === 'waiting')
        await run(await current(held.nodeId), PLAN_STREAM_COMMISSION_SLUG, 'running');
      if (status === 'blocked') {
        const asked = await wake();
        const answer = asked.decisions[0]?.answer;
        if (answer?.decision === 'ask' && answer.update)
          await updatePlanNode(session(), answer.update);
      }
      const root = await created();
      const child = await created({ parentId: root.nodeId });
      await write(child.nodeId, { status: 'done', outcome: 'Complete' });
      expect(await wake()).toMatchObject({ decisions: [], propose: { parentId: root.nodeId } });
    },
  );

  it.each(['open', 'update'] as const)(
    'closes a rail-approved live check with the read recorded and never commissions its merged goal (%s)',
    async (method) => {
      const check = await created({
        kind: 'investigate',
        liveCheck: { pullRequest: PR, mergeCommitSha: MERGE_SHA },
      });
      const resident = await openPlanNode(
        { ...session(), resident: true },
        { nodeId: check.nodeId, expectedRevision: check.revision },
      );
      expect(resident).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
      const approved =
        method === 'open'
          ? await openPlanNode(session(), {
              nodeId: check.nodeId,
              expectedRevision: check.revision,
              why: 'Read the folder',
            })
          : await updatePlanNode(session(), {
              nodeId: check.nodeId,
              expectedRevision: check.revision,
              status: 'active',
            });
      expect(approved).toMatchObject({
        ok: true,
        node: { status: 'done', outcome: expect.stringContaining("folder's head") },
      });
      expect(await wake()).toMatchObject({ decisions: [] });
      const closed = await current(check.nodeId);
      expect(
        await openPlanNode(session(), {
          nodeId: closed.nodeId,
          expectedRevision: closed.revision,
          why: 'Read the folder again',
        }),
      ).toMatchObject({ ok: true, node: { status: 'blocked' } });
      expect((await current(check.nodeId)).outcome).toBeUndefined();
    },
  );

  it.each(['done', 'dropped'] as const)(
    'respects a person reopening a %s live check',
    async (status) => {
      const check = await created({
        kind: 'investigate',
        liveCheck: { pullRequest: PR, mergeCommitSha: MERGE_SHA },
      });
      await write(check.nodeId, { status, outcome: 'The person closed this check.' });
      const closed = await current(check.nodeId);
      const reopened = await openPlanNode(session(), {
        nodeId: closed.nodeId,
        expectedRevision: closed.revision,
        why: 'The folder needs another read.',
      });
      expect(reopened).toMatchObject({ ok: true, node: { status: 'blocked' } });
      expect((await current(check.nodeId)).note).toContain(
        'Reopened: The folder needs another read.',
      );
      expect((await current(check.nodeId)).note).not.toContain('Approved:');
      expect(await wake()).toMatchObject({ decisions: [{ answer: { decision: 'ask' } }] });
      expect((await current(check.nodeId)).outcome).toBeUndefined();
      expect((await current(check.nodeId)).closedAt).toBeUndefined();
    },
  );

  it.each([0, 1, 100, PLAN_NODE_PROSE_MAX_CHARS - 2, PLAN_NODE_PROSE_MAX_CHARS])(
    'preserves every character of an operator note of length %i when asking',
    async (length) => {
      const note = 'x'.repeat(length);
      const node = await created({ note });
      const ask = planAsk({ ...node, status: 'blocked' });
      expect((ask.update?.note ?? note).length).toBeLessThanOrEqual(PLAN_NODE_PROSE_MAX_CHARS);
      expect((ask.update?.note ?? note).slice(0, length)).toBe(note);
    },
  );

  it('does not read siblings when a closed step has no findings', async () => {
    const node = await created();
    const siblings = vi.spyOn(store, 'listChildren').mockRejectedValue(new Error('unavailable'));
    expect(await write(node.nodeId, { status: 'done', outcome: 'Met' })).toMatchObject({
      status: 'done',
    });
    expect(siblings).not.toHaveBeenCalled();
  });

  it.each(['pageLinks', 'latestCarrierAt'] as const)(
    'keeps a successful close when carrier %s fails',
    async (read) => {
      const root = await created();
      const node = await created({ parentId: root.nodeId });
      await linkPlanNode(session(), { nodeId: node.nodeId, kind: 'finding', ref: 'F1' });
      vi.spyOn(store, read).mockRejectedValue(new Error('unavailable'));
      expect(await write(node.nodeId, { status: 'done', outcome: 'Met' })).toMatchObject({
        status: 'done',
      });
    },
  );

  it('files an offered proposal under its named root and remembers its decline on later wakes', async () => {
    const root = await created();
    const child = await created({ parentId: root.nodeId });
    await write(child.nodeId, { status: 'done', outcome: 'Met' });
    const offered = (await wake()).propose;
    if (!offered) throw new Error('No proposal');
    expect(offered.parentId).toBe(root.nodeId);
    const proposal = await created({ parentId: offered.parentId, proposed: offered.reason });
    await write(proposal.nodeId, { status: 'dropped', outcome: 'Declined' });
    expect(await wake()).not.toHaveProperty('propose');
    expect(await wake({}, 'later')).not.toHaveProperty('propose');
  });

  it.each(['done', 'dropped'] as const)(
    'refuses resident reopening of %s scope',
    async (status) => {
      const node = await created({ proposed: 'Needs approval' });
      const closed = await write(node.nodeId, { status, outcome: 'Operator closed' });
      for (const reopen of ['active', 'waiting', 'blocked'] as const) {
        expect(
          await updatePlanNode(
            { ...session(), resident: true },
            {
              nodeId: node.nodeId,
              expectedRevision: closed.revision,
              status: reopen,
            },
          ),
        ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
      }
      expect((await current(node.nodeId)).status).toBe(status);
    },
  );

  it.each(['blocked', 'done', 'dropped'] as const)(
    'refuses resident settlement of %s scope but permits notes',
    async (status) => {
      const node = await created({ proposed: 'Needs approval' });
      if (status !== 'blocked') await write(node.nodeId, { status, outcome: 'Operator closed' });
      const before = await current(node.nodeId);
      for (const close of ['done', 'dropped'] as const) {
        expect(
          await updatePlanNode(
            { ...session(), resident: true },
            {
              nodeId: node.nodeId,
              expectedRevision: before.revision,
              status: close,
              outcome: 'Self settled',
            },
          ),
        ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
      }
      expect(await current(node.nodeId)).toEqual(before);
      if (status !== 'blocked') {
        expect(
          await updatePlanNode(
            { ...session(), resident: true },
            {
              nodeId: node.nodeId,
              expectedRevision: before.revision,
              outcome: 'Rewritten',
            },
          ),
        ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
      }
      expect(
        await updatePlanNode(
          { ...session(), resident: true },
          {
            nodeId: node.nodeId,
            expectedRevision: before.revision,
            note: 'Waiting for operator',
          },
        ),
      ).toMatchObject({ ok: true });
    },
  );

  it('keeps a declined proposal local to its root and tries the next root', async () => {
    const first = await created({ title: 'Declined root' });
    const second = await created({ title: 'Eligible root' });
    for (const root of [first, second]) {
      const child = await created({ parentId: root.nodeId });
      await write(child.nodeId, { status: 'done', outcome: 'Merged' });
    }
    const proposal = await created({ parentId: first.nodeId, proposed: 'Next scope' });
    await write(proposal.nodeId, { status: 'dropped', outcome: 'Declined' });
    expect(await wake()).toMatchObject({ propose: { title: second.title } });
  });

  it('does not suppress proposals when space history exceeds the walk limit', async () => {
    const root = await created();
    const child = await created({ parentId: root.nodeId });
    await write(child.nodeId, { status: 'done', outcome: 'Merged' });
    for (let i = 0; i <= PLAN_TREE_WALK_NODE_LIMIT; i++) {
      store.seed(SPACE, { title: String(i), status: 'done' });
    }
    expect(await wake()).toHaveProperty('propose');
  });

  it('a dropped findings carrier does not decline proposals for its root', async () => {
    const root = await created();
    const step = await created({ parentId: root.nodeId });
    await linkPlanNode(session(), { nodeId: step.nodeId, kind: 'finding', ref: 'open' });
    const closed = await updatePlanNode(session(), {
      nodeId: step.nodeId,
      expectedRevision: step.revision,
      status: 'done',
      outcome: 'Merged',
    });
    if (!closed.ok || !closed.carrier) throw new Error('No carrier');
    await write(closed.carrier.nodeId, { status: 'dropped' });
    expect(await wake()).toHaveProperty('propose');
  });

  it('bounds carrier goals while keeping a pointer to complete findings', async () => {
    const step = await created();
    const finding = {
      nodeId: step.nodeId,
      kind: 'finding' as const,
      ref: 'ref',
      label: 'x'.repeat(64000),
      createdAt: step.createdAt,
    };
    const carrier = carrierNode(
      step,
      Array.from({ length: 50 }, () => finding),
      5,
    );
    expect(carrier.goal.length).toBeLessThanOrEqual(PLAN_NODE_PROSE_MAX_CHARS);
    expect(carrier.goal).toContain('See the findings linked to step ' + step.nodeId);
    expect(PlanNodeSchema.safeParse({ ...step, ...carrier }).success).toBe(true);
  });

  it.each([0, 49, 50, 60])(
    'counts only uncarried findings across all finding pages in overflow (%s new)',
    async (fresh) => {
      const root = await created();
      const step = await created({ parentId: root.nodeId });
      for (let i = 0; i < 105; i++) store.seed(SPACE, { parentId: root.nodeId, status: 'done' });
      for (let i = 0; i < 55; i++) {
        await linkPlanNode(session(), {
          nodeId: step.nodeId,
          kind: 'finding',
          ref: 'old:' + String(i),
        });
      }
      const closed = await updatePlanNode(session(), {
        nodeId: step.nodeId,
        expectedRevision: step.revision,
        status: 'done',
        outcome: 'Merged',
      });
      if (!closed.ok || !closed.carrier) throw new Error('No carrier');
      expect(closed.carrier.goal).toContain('and 5 more');
      // Separate the carrier watermark from findings that arrive after it.
      store.nodes.set(closed.carrier.nodeId, {
        ...closed.carrier,
        createdAt: '2020-01-02T00:00:00.000Z',
      });
      for (const link of store.links) link.createdAt = '2020-01-01T00:00:00.000Z';
      await write(step.nodeId, { status: 'active' });
      for (let i = 0; i < fresh; i++) {
        await linkPlanNode(session(), {
          nodeId: step.nodeId,
          kind: 'finding',
          ref: 'new:' + String(i),
        });
      }
      const pageLinks = vi.spyOn(store, 'pageLinks');
      const again = await updatePlanNode(session(), {
        nodeId: step.nodeId,
        expectedRevision: (await current(step.nodeId)).revision,
        status: 'done',
        outcome: 'Merged again',
      });
      if (!again.ok) throw new Error(again.message);
      expect(pageLinks.mock.calls.length).toBeGreaterThan(1);
      if (fresh === 0) expect(again.carrier).toBeUndefined();
      else {
        expect(again.carrier?.goal).toContain('new:');
        expect(again.carrier?.goal).not.toContain('old:');
        if (fresh > 50) expect(again.carrier?.goal).toContain('and 10 more');
        else expect(again.carrier?.goal).not.toContain('more linked');
      }
    },
  );

  it('does not commission an exhausted root in either path beyond a child page', async () => {
    const root = await created();
    for (let i = 0; i < 105; i++) {
      store.seed(SPACE, { parentId: root.nodeId, title: `closed ${String(i)}`, status: 'done' });
    }
    expect(await fire(root.nodeId)).toMatchObject({ decision: 'wait', cause: 'stream_closed' });
    expect((await wake()).decisions).toEqual([]);
  });

  it('treats a dropped proposal as a decline on following wakes', async () => {
    const root = await created();
    const child = await created({ parentId: root.nodeId });
    await write(child.nodeId, { status: 'done', outcome: 'Merged' });
    expect(await wake()).toHaveProperty('propose');
    const proposal = await created({ parentId: root.nodeId, proposed: 'Next scope' });
    await write(proposal.nodeId, { status: 'dropped', outcome: 'Declined' });
    expect(await wake()).not.toHaveProperty('propose');
    expect(await wake({}, 'another-wake')).not.toHaveProperty('propose');
  });

  it.each([false, true])(
    'treats a proposal the operator revised and then dropped as a decline (rewritten: %s)',
    async (rewritten) => {
      const root = await created();
      const child = await created({ parentId: root.nodeId });
      await write(child.nodeId, { status: 'done', outcome: 'Merged' });
      const proposal = await created({ parentId: root.nodeId, proposed: 'Next scope' });
      const revised = await revisePlanNode(session(), {
        nodeId: proposal.nodeId,
        expectedRevision: proposal.revision,
        why: 'Name the risk.',
      });
      if (!revised.ok) throw new Error(revised.message);
      if (rewritten) {
        const note = revised.node.note!.replace(/^Revise: [^\n]*/, 'Revised: the risk is named.');
        await write(proposal.nodeId, { note });
      }
      await write(proposal.nodeId, { status: 'dropped', outcome: 'Declined' });

      expect(await wake()).not.toHaveProperty('propose');
      expect(await wake({}, 'another-wake')).not.toHaveProperty('propose');
    },
  );

  it('a findings carrier the operator revised and then dropped does not decline its root', async () => {
    const root = await created();
    const step = await created({ parentId: root.nodeId });
    await linkPlanNode(session(), { nodeId: step.nodeId, kind: 'finding', ref: 'open' });
    const closed = await updatePlanNode(session(), {
      nodeId: step.nodeId,
      expectedRevision: step.revision,
      status: 'done',
      outcome: 'Merged',
    });
    if (!closed.ok || !closed.carrier) throw new Error('No carrier');
    await revisePlanNode(session(), {
      nodeId: closed.carrier.nodeId,
      expectedRevision: closed.carrier.revision,
      why: 'Only the first finding.',
    });
    await write(closed.carrier.nodeId, { status: 'dropped' });
    expect(await wake()).toHaveProperty('propose');
  });

  it.each([true, false])(
    'surfaces a live check beside its merged node (nested: %s)',
    async (nested) => {
      const root = await created();
      const node = nested ? await created({ parentId: root.nodeId }) : root;
      const mergedAt = await publishedRound(node);
      const answer = await fire(root.nodeId, (url) => merged(url, mergedAt));
      if (answer.decision !== 'record_merge') throw new Error('expected merge');
      const check = await createPlanNode(session(), answer.liveCheck);
      if (!check.ok) throw new Error(check.message);
      expect(check.node.note).toContain('waits on a person to read');
      expect(check.node.parentId).toBe(node.parentId);
      // Even before the close lands, the new sibling cannot hide the merged node.
      expect(await fire(root.nodeId, (url) => merged(url, mergedAt))).toMatchObject({
        decision: 'record_merge',
      });
      await write(node.nodeId, { status: 'done', outcome: 'Merged' });
      expect((await wake()).decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            answer: expect.objectContaining({
              decision: 'ask',
              node: expect.objectContaining({ nodeId: check.node.nodeId }),
            }),
          }),
        ]),
      );
      expect(await listWaitingNodes(session())).toEqual(
        expect.arrayContaining([expect.objectContaining({ nodeId: check.node.nodeId })]),
      );
    },
  );
  it('asks once across two wakes and exposes exactly one Action Center target', async () => {
    const node = await created({ proposed: 'Needs operator approval' });
    const first = await wake();
    expect(first.decisions).toHaveLength(1);
    const answer = first.decisions[0]!.answer;
    expect(answer.decision).toBe('ask');
    if (answer.decision === 'ask' && answer.update) await updatePlanNode(session(), answer.update);
    expect(await listWaitingNodes(session())).toMatchObject([{ nodeId: node.nodeId }]);
    expect((await wake({}, 'wake-b')).decisions).toEqual([]);
    expect(await listWaitingNodes(session())).toHaveLength(1);
  });

  it('keeps actionable work ahead of asks at the per-wake cap', async () => {
    const blocked = await created({ proposed: 'Ask first in root order' });
    const active = await created();
    const result = await wake({ decisions: 1 });
    expect(result.decisions[0]!.answer).toMatchObject({
      decision: 'continue',
      node: { nodeId: active.nodeId },
    });
    expect(result.deferred).toBe(1);
    expect(await redis.get(askedKey(TENANT, SPACE, blocked.nodeId))).toBeNull();
    // Unasked, it is listed all the same: the record gates the note, not the item.
    expect(await listWaitingNodes(session())).toMatchObject([{ nodeId: blocked.nodeId }]);
  });

  it('reads pull requests before asking, leaving capped asks unclaimed', async () => {
    const blocked = await created({ proposed: 'First root needs approval' });
    const node = await created();
    await linkPlanNode(session(), { nodeId: node.nodeId, kind: 'pull_request', ref: PR });
    const result = await wake({ decisions: 1 });
    expect(result.decisions).toMatchObject([{ answer: { decision: 'read_pull_request' } }]);
    expect(result.deferred).toBe(1);
    expect(await redis.get(askedKey(TENANT, SPACE, blocked.nodeId))).toBeNull();
  });

  it('proposes toward an exhausted open root with title, goal and criteria', async () => {
    const root = await created();
    const child = await created({ parentId: root.nodeId });
    await write(child.nodeId, { status: 'done', outcome: 'Merged' });
    expect(await wake()).toMatchObject({
      decisions: [],
      propose: {
        parentId: root.nodeId,
        title: root.title,
        goal: root.goal,
        criteria: root.criteria,
      },
    });
  });

  it('refuses resident creation of active work and approval of blocked work', async () => {
    const resident = { ...session(), resident: true };
    expect(
      await createPlanNode(resident, {
        kind: 'execute',
        title: 'Unapproved',
        goal: 'g',
        criteria: 'c',
      }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
    const node = await created({ proposed: 'Needs approval' });
    expect(
      await updatePlanNode(resident, {
        nodeId: node.nodeId,
        expectedRevision: node.revision,
        status: 'active',
      }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
    expect((await current(node.nodeId)).status).toBe('blocked');
  });

  it('proposes a carrier on done-close and recognises it after approval with a reason', async () => {
    const root = await created();
    const step = await created({ parentId: root.nodeId });
    await linkPlanNode(session(), {
      nodeId: step.nodeId,
      kind: 'finding',
      ref: 'review:open-1',
      label: 'Fix the edge case',
    });
    const close = await updatePlanNode(session(), {
      nodeId: step.nodeId,
      expectedRevision: step.revision,
      status: 'done',
      outcome: 'Merged with an open finding',
    });
    expect(close).toMatchObject({
      ok: true,
      carrier: {
        parentId: root.nodeId,
        status: 'blocked',
        goal: expect.stringContaining('review:open-1'),
      },
    });
    if (!close.ok || !close.carrier) throw new Error('No carrier');
    await wake();
    await wake({}, 'second-wake');
    expect(await listWaitingNodes(session())).toHaveLength(1);
    const carrier = await current(close.carrier.nodeId);
    expect(
      await openPlanNode(session(), {
        nodeId: carrier.nodeId,
        expectedRevision: carrier.revision,
        why: 'Approved for the next round',
      }),
    ).toMatchObject({ ok: true });
    await openPlanNode(session(), {
      nodeId: step.nodeId,
      expectedRevision: (await current(step.nodeId)).revision,
    });
    const again = await updatePlanNode(session(), {
      nodeId: step.nodeId,
      expectedRevision: (await current(step.nodeId)).revision,
      status: 'done',
      outcome: 'Still done',
    });
    expect(again.ok && again.carrier).toBeUndefined();
    expect(
      [...store.nodes.values()].filter((n) => n.title.startsWith('Carry the open findings')),
    ).toHaveLength(1);
  });
});

describe('plan.node.next across the board (Plan 331 D2)', () => {
  it('commissions the first root by position, and the other once the operator swaps them', async () => {
    const a = await created({ title: 'Plan 330' });
    const aStep = await created({ parentId: a.nodeId, title: '330 P1' });
    const b = await created({ title: 'Plan 331' });
    const bStep = await created({ parentId: b.nodeId, title: '331 P1' });

    const first = await wake({ decisions: 1 }, 'wake-1');
    expect(first.decisions).toHaveLength(1);
    expect(first.decisions[0]).toMatchObject({
      root: { nodeId: a.nodeId },
      answer: { decision: 'continue', node: { nodeId: aStep.nodeId } },
    });
    expect(first.deferred).toBe(1);

    await write(a.nodeId, { position: 5 });
    await write(b.nodeId, { position: 0 });
    const next = await wake({ decisions: 1 }, 'wake-2');
    expect(next.decisions[0]).toMatchObject({
      root: { nodeId: b.nodeId },
      answer: { decision: 'continue', node: { nodeId: bStep.nodeId } },
    });
  });

  it('finishes before it starts: a publication ranks ahead of new work in an earlier root', async () => {
    const early = await created({ title: 'Plan 330' });
    await created({ parentId: early.nodeId, title: '330 P1' });
    const late = await created({ title: 'Plan 331' });
    const lateStep = await created({ parentId: late.nodeId, title: '331 P1' });
    const commission = await run(lateStep, PLAN_STREAM_COMMISSION_SLUG, 'completed');

    const board = await wake();
    expect(board.decisions.map((d) => d.answer.decision)).toEqual(['publish', 'continue']);
    expect(board.decisions[0]).toMatchObject({
      root: { nodeId: late.nodeId },
      answer: { commission: { commission } },
    });
  });

  it('is silent where every root waits: no decision, no node written, the waits counted by cause', async () => {
    const running = await created({ title: 'Plan 330' });
    const step = await created({ parentId: running.nodeId, title: '330 P1' });
    await run(step, PLAN_STREAM_COMMISSION_SLUG, 'running');
    const held = await created({ title: 'Plan 331' });
    await created({ parentId: held.nodeId, title: 'proposed', note: 'Proposed: …' });
    const proposed = [...store.nodes.values()].find((n) => n.title === 'proposed')!;
    await write(proposed.nodeId, { status: 'blocked' });
    await wake();
    const before = revisions();

    const board = await wake();
    expect(board.decisions).toEqual([]);
    expect(board.deferred).toBe(0);
    expect(board.waits).toEqual(
      expect.arrayContaining([
        { cause: 'in_flight', roots: 1 },
        { cause: 'blocked', roots: 1 },
      ]),
    );
    expect(revisions()).toEqual(before);
  });

  it('never commissions a blocked node, whatever its rounds, and holds its stream there', async () => {
    const root = await created({ title: 'Plan 331' });
    const blocked = await created({ parentId: root.nodeId, title: 'P2 — proposed' });
    const after = await created({ parentId: root.nodeId, title: 'P3' });
    await run(blocked, PLAN_STREAM_COMMISSION_SLUG, 'failed', { failure: 'boom' });
    await write(blocked.nodeId, { status: 'blocked', note: 'Proposed: carry the findings.' });

    const board = await wake();
    expect(board.decisions).toMatchObject([{ answer: { decision: 'ask' } }]);
    expect(board.waits).toEqual([]);
    expect(
      board.decisions.some(
        (d) => d.answer.decision === 'continue' && d.answer.node.nodeId === after.nodeId,
      ),
    ).toBe(false);
  });

  it('acts on every root an event touched in one wake, up to its cap, and defers the rest', async () => {
    const roots: PlanNode[] = [];
    for (const n of [1, 2, 3, 4]) {
      const root = await created({ title: `Plan ${String(n)}` });
      const step = await created({ parentId: root.nodeId, title: `step ${String(n)}` });
      await run(step, PLAN_STREAM_COMMISSION_SLUG, 'completed');
      roots.push(root);
    }
    const board = await wake({ decisions: 3 });
    expect(board.decisions.map((d) => d.root.nodeId)).toEqual(
      roots.slice(0, 3).map((r) => r.nodeId),
    );
    expect(board.decisions.every((d) => d.answer.decision === 'publish')).toBe(true);
    expect(board.deferred).toBe(1);
  });

  it('claims only the continues it answers, so a deferred one is free for the next wake', async () => {
    for (const n of [1, 2]) {
      const root = await created({ title: `Plan ${String(n)}` });
      await created({ parentId: root.nodeId, title: `step ${String(n)}` });
    }
    const first = await wake({ decisions: 1 }, 'wake-1');
    const second = await wake({ decisions: 2 }, 'wake-2');
    expect(first.decisions).toHaveLength(1);
    expect(second.decisions).toHaveLength(1);
    expect(second.decisions[0]!.root.nodeId).not.toBe(first.decisions[0]!.root.nodeId);
    expect(second.waits).toEqual([{ cause: 'claimed', roots: 1 }]);
  });
});

describe('publish — a completed commission is published by the next wake (Plan 331 D3.1)', () => {
  it('answers publish with the commission’s run id and what Local Publish takes', async () => {
    const { root, first } = await stream();
    const commission = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed', {
      commission: {
        patchRef: 'payload:patch-1',
        baseSha: 'abc1234',
        mergeFrom: 'def5678',
        bindingId: 'hb_aflow',
      },
    });
    expect(await fire(root.nodeId)).toMatchObject({
      decision: 'publish',
      node: { nodeId: first.nodeId, goal: first.goal, criteria: first.criteria },
      commission: {
        commission,
        patchRef: 'payload:patch-1',
        baseSha: 'abc1234',
        mergeFrom: 'def5678',
        bindingId: 'hb_aflow',
      },
    });
  });

  it('a wake that commissions a node is answered publish once the commission completes, never a second commission', async () => {
    const { root, first } = await stream();
    const before = revisions();

    // The wake does what `continue` says: the commission, serving the node, and no node write.
    const started = await wake({}, 'wake-1');
    expect(started.decisions[0]).toMatchObject({
      answer: { decision: 'continue', node: { nodeId: first.nodeId } },
    });
    const commission = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'running');
    expect(revisions()).toEqual(before);

    expect((await wake({}, 'wake-2')).decisions).toEqual([]);
    ends(commission, 'completed');
    await linkEndedRun(session(), {
      nodeId: first.nodeId,
      runId: commission,
      slug: PLAN_STREAM_COMMISSION_SLUG,
      status: 'completed',
    });

    const published = await wake({}, 'wake-3');
    expect(published.decisions).toHaveLength(1);
    expect(published.decisions[0]).toMatchObject({
      root: { nodeId: root.nodeId },
      answer: { decision: 'publish', commission: { commission } },
    });
    await run(first, PLAN_STREAM_PUBLICATION_SLUG, 'running');
    expect((await wake({}, 'wake-4')).decisions).toEqual([]);
    expect(
      store.runs.filter((r) => r.nodeId === first.nodeId && r.slug === PLAN_STREAM_COMMISSION_SLUG),
    ).toHaveLength(1);
  });

  it('the `continue` a wake acts on writes nothing to the node: a write after the start would hide the commission', async () => {
    const pitfalls = getOperation(PLAN_NODE_NEXT_OPERATION_ID)?.usage?.pitfalls ?? [];
    const onContinue = pitfalls.find((p) => p.startsWith('continue:'));
    expect(onContinue).toContain('Write nothing to the node');
    expect(onContinue).not.toMatch(/write one line[^.]*note/);

    // A node write cannot discard a finished, unpublished patch.
    const { root, first } = await stream();
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed');
    await write(first.nodeId, { note: 'Started a commission.' });
    expect(await fire(root.nodeId)).toMatchObject({ decision: 'publish' });
  });

  it('waits once the publication is under way', async () => {
    const { root, first } = await stream();
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed');
    await run(first, PLAN_STREAM_PUBLICATION_SLUG, 'running');
    expect(await fire(root.nodeId)).toMatchObject({ decision: 'wait', cause: 'in_flight' });
  });

  it('stops on a commission that made no change, for a person to read', async () => {
    const { root, first } = await stream();
    const commission = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed', {
      commission: { baseSha: 'abc1234' },
    });
    const decided = await fire(root.nodeId);
    expect(decided).toMatchObject({
      decision: 'stop',
      cause: 'commission_unchanged',
      update: { nodeId: first.nodeId, status: 'blocked' },
    });
    expect(decided.reason).toContain(commission);
  });

  it('does not publish twice: a publication naming the commission elsewhere holds it', async () => {
    const { root, first } = await stream();
    const other = await created({ title: 'elsewhere' });
    const commission = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed');
    const elsewhere = await run(other, PLAN_STREAM_PUBLICATION_SLUG, 'completed');
    publishes.set(elsewhere, commission);
    const decided = await fire(root.nodeId);
    expect(decided).toMatchObject({ decision: 'wait', cause: 'unknown_state' });
    expect(decided.reason).toContain(elsewhere);
  });
});

describe('the node spend stop (Plan 331 D4)', () => {
  it('stops a node whose runs cost its ceiling, naming the spend and the runs, and holds its later siblings', async () => {
    const { root, first, second } = await stream();
    store.nodes.set(first.nodeId, { ...first, spendCents: 500 });
    const a = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'failed', { cents: 300, failure: 'x' });
    const b = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'failed', { cents: 250, failure: 'y' });
    const decided = await next(root.nodeId, { attempts: 10 });
    expect(decided).toMatchObject({
      decision: 'stop',
      cause: 'spend_spent',
      node: { nodeId: first.nodeId },
      spend: { cents: 550, ceilingCents: 500, runIds: [b, a] },
      update: { nodeId: first.nodeId, status: 'blocked' },
    });
    if (decided.decision !== 'stop') throw new Error('expected a stop');
    expect(decided.update.note).toMatch(/^Blocked: Its runs cost \$5\.50/);
    expect(decided.update.note).toContain(a);
    expect(decided.update.note).toContain(b);

    await updatePlanNode(session(), decided.update);
    const board = await wake({ attempts: 10 });
    expect(board.decisions).toMatchObject([{ answer: { decision: 'ask' } }]);
    expect(board.waits).toEqual([]);
    expect((await current(second.nodeId)).revision).toBe(second.revision);
  });

  it('starts the spend afresh through open, no audit row awaited', async () => {
    const { root, first } = await stream();
    store.nodes.set(first.nodeId, { ...first, spendCents: 500 });
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'failed', { cents: 600, failure: 'x' });
    const stopped = await next(root.nodeId, { attempts: 10 });
    if (stopped.decision !== 'stop') throw new Error('expected a stop');
    expect(stopped.cause).toBe('spend_spent');
    await updatePlanNode(session(), stopped.update);

    const openedAt = new Date(stamp());
    vi.setSystemTime(openedAt);
    try {
      const blocked = await current(first.nodeId);
      const opened = await openPlanNode(session(), {
        nodeId: first.nodeId,
        expectedRevision: blocked.revision,
        why: 'Raise the ceiling; the failure was the folder.',
      });
      expect(opened.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    // Written with the open itself: the next read sees it, with nothing else recorded.
    expect(store.openedAt.get(first.nodeId)).toEqual(openedAt);
    expect(await next(root.nodeId, { attempts: 10 })).not.toMatchObject({
      cause: 'spend_spent',
    });

    const after = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'failed', {
      cents: 600,
      failure: 'y',
    });
    expect(await next(root.nodeId, { attempts: 10 })).toMatchObject({
      decision: 'stop',
      cause: 'spend_spent',
      spend: { cents: 600, runIds: [after] },
    });
  });

  it('does not let an agent resume reset the window or a next argument raise its ceiling', async () => {
    const { root, first } = await stream();
    store.nodes.set(first.nodeId, { ...first, spendCents: 500 });
    const window = new Date(first.createdAt);
    store.openedAt.set(first.nodeId, window);
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'failed', { cents: 600 });
    const stopped = await next(root.nodeId);
    if (stopped.decision !== 'stop') throw new Error('expected stop');
    await updatePlanNode(session(), stopped.update);
    const blocked = await current(first.nodeId);
    await updatePlanNode(session(), {
      nodeId: first.nodeId,
      expectedRevision: blocked.revision,
      status: 'active',
    });
    expect(store.openedAt.get(first.nodeId)).toEqual(window);
    expect(
      PlanNodeNextInputSchema.safeParse({ rootNodeId: root.nodeId, spendCents: 1_000_000 }).success,
    ).toBe(false);
    const input = { ...PlanNodeNextInputSchema.parse({}), spendCents: 1_000_000 };
    const answer = await nextInPlanStream(streamContext(), root.nodeId, input);
    expect(answer).toMatchObject({
      ok: true,
      output: {
        decision: 'stop',
        cause: 'spend_spent',
        spend: { ceilingCents: 500 },
      },
    });
  });

  it('lets new human instructions supersede a commission that produced no patch', async () => {
    const { root, first } = await stream();
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed', { commission: {} });
    const stopped = await next(root.nodeId);
    if (stopped.decision !== 'stop') throw new Error('expected no-change stop');
    expect(stopped.cause).toBe('commission_unchanged');
    await updatePlanNode(session(), stopped.update);
    const blocked = await current(first.nodeId);
    await openPlanNode(session(), {
      nodeId: first.nodeId,
      expectedRevision: blocked.revision,
      why: 'Try the new requirements.',
    });
    expect(await next(root.nodeId)).toMatchObject({ decision: 'continue' });
  });

  it('publishes the finished patch past the ceiling and claims it once after stop and human Resume', async () => {
    const { root, first } = await stream();
    store.nodes.set(first.nodeId, { ...first, spendCents: 500 });
    const commission = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed', { cents: 600 });
    const blocked = await write(first.nodeId, { status: 'blocked', note: 'Blocked: spend spent.' });
    expect(await next(root.nodeId)).toMatchObject({ decision: 'wait', cause: 'blocked' });
    const opened = await openPlanNode(session(), {
      nodeId: first.nodeId,
      expectedRevision: blocked.revision,
      why: 'Publish the finished patch.',
      spendCents: 700,
    });
    expect(opened).toMatchObject({ ok: true, node: { spendCents: 700 } });
    // New spending can exhaust even the resumed window before the wake.
    const extra = await run(first, 'other-work', 'completed', { cents: 800 });
    expect(costs.get(extra)).toBe(800);
    expect(await next(root.nodeId, {}, 'wake-a')).toMatchObject({
      decision: 'publish',
      commission: { commission },
    });
    expect(await next(root.nodeId, {}, 'wake-b')).toMatchObject({
      decision: 'wait',
      cause: 'claimed',
    });
    const publication = await run(first, PLAN_STREAM_PUBLICATION_SLUG, 'running');
    publishes.set(publication, commission);
    expect(await next(root.nodeId, {}, 'wake-c')).toMatchObject({
      decision: 'wait',
      cause: 'in_flight',
    });
    ends(publication, 'completed');
    outcomes.set(publication, { prUrl: PR, afterReview: 'publish_as_is', pushDecision: 'push' });
    expect(await next(root.nodeId, {}, 'wake-d')).not.toMatchObject({ decision: 'publish' });
    expect(store.runs.filter((r) => publishes.get(r.runId) === commission)).toHaveLength(1);
    expect(store.runs.filter((r) => r.slug === PLAN_STREAM_COMMISSION_SLUG)).toHaveLength(1);
  });

  it('records a merge on a node at its ceiling: recording costs nothing', async () => {
    const { root, first } = await stream();
    store.nodes.set(first.nodeId, { ...first, spendCents: 500 });
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed', { cents: 900 });
    await run(first, PLAN_STREAM_PUBLICATION_SLUG, 'completed', {
      outcome: { prUrl: PR, afterReview: 'publish_as_is', pushDecision: 'push' },
    });
    const mergedAt = stamp();
    const first1 = await next(root.nodeId, {});
    expect(first1.decision).toBe('read_pull_request');
    expect(await next(root.nodeId, { pullRequest: merged(PR, mergedAt) })).toMatchObject({
      decision: 'record_merge',
    });
  });
});

describe('the open write (Plan 332 D6, Plan 331 D5)', () => {
  it('moves a blocked node to active, the operator’s reason the note’s first line', async () => {
    const { first } = await stream();
    const blocked = await write(first.nodeId, {
      status: 'blocked',
      note: 'Blocked: attempts spent.',
    });
    const opened = await openPlanNode(session(), {
      nodeId: first.nodeId,
      expectedRevision: blocked.revision,
      why: 'Try once more with the fixture.',
    });
    expect(opened).toMatchObject({ ok: true, from: 'blocked', node: { status: 'active' } });
    if (!opened.ok) throw new Error('expected the open');
    expect(opened.node.note).toBe(
      'Approved: Try once more with the fixture.\nBlocked: attempts spent.',
    );
  });

  it('refuses an open node that waits on no person, and a stale revision, writing nothing', async () => {
    const { first } = await stream();
    expect(
      await openPlanNode(session(), { nodeId: first.nodeId, expectedRevision: first.revision }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_UNCHANGED' });
    const blocked = await write(first.nodeId, { status: 'blocked' });
    expect(
      await openPlanNode(session(), { nodeId: first.nodeId, expectedRevision: first.revision }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_STALE' });
    expect((await current(first.nodeId)).revision).toBe(blocked.revision);
  });

  it('reopens a closed node under the engine’s reopened line, the reason after it', async () => {
    const { first } = await stream();
    const done = await write(first.nodeId, { status: 'done', outcome: 'Met by #200.' });
    const opened = await openPlanNode(session(), {
      nodeId: first.nodeId,
      expectedRevision: done.revision,
      why: 'The fix did not hold.',
    });
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.from).toBe('done');
    expect(opened.node.note).toBe(
      'Reopened; it was done: Met by #200.\nReopened: The fix did not hold.',
    );
  });

  it('the person’s write wins: a wake writing the same revision is refused, and nothing is lost', async () => {
    const { root, first } = await stream();
    const blocked = await write(first.nodeId, { status: 'blocked', note: 'Blocked: spend.' });
    const [approve, wakeWrite] = await Promise.all([
      openPlanNode(session(), {
        nodeId: first.nodeId,
        expectedRevision: blocked.revision,
        why: 'Raised the ceiling.',
      }),
      updatePlanNode(session(), {
        nodeId: first.nodeId,
        expectedRevision: blocked.revision,
        note: 'Blocked: spend.\nwake: asked once.',
      }),
    ]);
    const outcomes = [approve, wakeWrite];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.find((o) => !o.ok)).toMatchObject({ code: 'PLAN_NODE_STALE' });
    const now = await current(first.nodeId);
    expect(now.revision).toBe(blocked.revision + 1);
    if (approve.ok) {
      expect(now).toMatchObject({ status: 'active' });
      expect(now.note?.split('\n')[0]).toBe('Approved: Raised the ceiling.');
      expect(await fire(root.nodeId)).toMatchObject({
        decision: 'continue',
        node: { nodeId: first.nodeId },
      });
    }
  });
});

describe('the operator’s note on a node (Plan 337 P4)', () => {
  it('approve with instructions: the next commission’s brief carries the operator’s line', async () => {
    const { root, first } = await stream();
    const blocked = await write(first.nodeId, {
      status: 'blocked',
      note: 'Proposed from the merged plan document',
    });
    await openPlanNode(session(), {
      nodeId: first.nodeId,
      expectedRevision: blocked.revision,
      why: 'Do it, and make sure\nthe migration is reversible.',
    });

    const answer = await next(root.nodeId);

    expect(answer).toMatchObject({
      decision: 'continue',
      node: {
        nodeId: first.nodeId,
        instructions: 'Approved: Do it, and make sure the migration is reversible.',
        goal: 'A stream continues on a schedule.',
      },
    });
  });

  it('a brief carries no instructions where the note’s first line is not the operator’s', async () => {
    const { root, first } = await stream();
    await write(first.nodeId, { note: 'next: the schema.\nApproved: an older line.' });

    const answer = await next(root.nodeId);

    if (answer.decision !== 'continue')
      throw new Error(`expected continue, not ${answer.decision}`);
    expect(answer.node).not.toHaveProperty('instructions');
  });

  it('revise: the node stays blocked, the wake is asked to rewrite it, and a rewrite ends the ask', async () => {
    const { root, first } = await stream();
    const blocked = await write(first.nodeId, {
      status: 'blocked',
      note: 'Proposed by the resident',
    });
    expect(await next(root.nodeId)).toMatchObject({ decision: 'wait', cause: 'blocked' });

    const revised = await revisePlanNode(session(), {
      nodeId: first.nodeId,
      expectedRevision: blocked.revision,
      why: 'Split it: the schema first.',
    });
    if (!revised.ok) throw new Error(revised.message);
    expect(revised.node).toMatchObject({ status: 'blocked', revision: blocked.revision + 1 });

    const answer = await next(root.nodeId);
    expect(answer).toMatchObject({
      decision: 'revise',
      noteHead: 'Revised: ',
      node: { nodeId: first.nodeId, instructions: 'Revise: Split it: the schema first.' },
    });
    expect(store.runs).toEqual([]);

    // The Helmsman rewrites the proposal with the update it already holds.
    await write(first.nodeId, {
      goal: 'Add the schema for the stream.',
      note: 'Revised: the schema comes first; the routes follow as their own step.',
    });
    expect(await current(first.nodeId)).toMatchObject({ status: 'blocked' });
    expect(await next(root.nodeId)).toMatchObject({ decision: 'wait', cause: 'blocked' });
  });

  it('revise: answers a blocked node sent back where it is not the active node', async () => {
    const { root, first, second } = await stream();
    await write(first.nodeId, { status: 'blocked', note: 'Waiting on a person' });
    const blocked = await write(second.nodeId, { status: 'blocked', note: 'Proposed' });
    expect(await next(root.nodeId)).toMatchObject({
      decision: 'wait',
      cause: 'blocked',
      node: { nodeId: first.nodeId },
    });

    const revised = await revisePlanNode(session(), {
      nodeId: second.nodeId,
      expectedRevision: blocked.revision,
      why: 'Name the risk.',
    });
    if (!revised.ok) throw new Error(revised.message);

    expect(await next(root.nodeId)).toMatchObject({
      decision: 'revise',
      node: { nodeId: second.nodeId, instructions: 'Revise: Name the risk.' },
    });

    await write(second.nodeId, { note: 'Revised: the risk is named.' });
    expect(await next(root.nodeId)).toMatchObject({
      decision: 'wait',
      cause: 'blocked',
      node: { nodeId: first.nodeId },
    });
  });

  it('revise: a publication on the active node ranks before a sent-back node under the same root', async () => {
    const { root, first, second } = await stream();
    const blocked = await write(second.nodeId, { status: 'blocked', note: 'Proposed' });
    await revisePlanNode(session(), {
      nodeId: second.nodeId,
      expectedRevision: blocked.revision,
      why: 'Name the risk.',
    });
    expect(await next(root.nodeId)).toMatchObject({
      decision: 'revise',
      node: { nodeId: second.nodeId },
    });

    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed');
    expect(await next(root.nodeId)).toMatchObject({
      decision: 'publish',
      node: { nodeId: first.nodeId },
    });
  });

  it('revise: a line the rewrite left in place stops the ask and is surfaced', async () => {
    const { root, first, second } = await stream();
    const blocked = await write(first.nodeId, { status: 'blocked', note: 'Proposed' });
    await revisePlanNode(session(), {
      nodeId: first.nodeId,
      expectedRevision: blocked.revision,
      why: 'Split it: the schema first.',
    });
    expect(await next(root.nodeId)).toMatchObject({ decision: 'revise' });

    // The rewrite changes the goal and keeps the operator's line on top.
    const rewritten = await write(first.nodeId, { goal: 'Add the schema for the stream.' });
    expect(rewritten.note?.startsWith('Revise: Split it')).toBe(true);
    expect(await next(root.nodeId)).toMatchObject({
      decision: 'wait',
      cause: 'revise_unanswered',
      node: { nodeId: first.nodeId },
    });

    // Sent back again, it is asked again.
    await revisePlanNode(session(), {
      nodeId: first.nodeId,
      expectedRevision: rewritten.revision,
      why: 'Keep the routes out.',
    });
    expect(await next(root.nodeId)).toMatchObject({
      decision: 'revise',
      node: { instructions: 'Revise: Keep the routes out.' },
    });

    // A sent-back node off the active path no longer holds new work once its line survives.
    await write(first.nodeId, { status: 'active', note: 'Approved.' });
    const proposed = await write(second.nodeId, { status: 'blocked', note: 'Proposed' });
    await revisePlanNode(session(), {
      nodeId: second.nodeId,
      expectedRevision: proposed.revision,
      why: 'Name the risk.',
    });
    expect(await next(root.nodeId)).toMatchObject({ decision: 'revise' });
    await write(second.nodeId, { criteria: 'The risk is named.' });
    expect(await next(root.nodeId)).toMatchObject({
      decision: 'continue',
      node: { nodeId: first.nodeId },
    });
  });

  it('revise: answered once per revision, so an unwritten answer frees the root’s other work', async () => {
    const { root, first, second } = await stream();
    const blocked = await write(second.nodeId, { status: 'blocked', note: 'Proposed' });
    await revisePlanNode(session(), {
      nodeId: second.nodeId,
      expectedRevision: blocked.revision,
      why: 'Name the risk.',
    });

    const raced = await Promise.all([
      next(root.nodeId, {}, 'firing-a'),
      next(root.nodeId, {}, 'firing-b'),
    ]);
    expect(raced.filter((d) => d.decision === 'revise')).toHaveLength(1);
    expect(raced.find((d) => d.decision !== 'revise')).toMatchObject({
      decision: 'wait',
      cause: 'claimed',
      node: { nodeId: second.nodeId },
    });

    // The wake answered and wrote nothing: the node stands at the same revision.
    expect(await current(second.nodeId)).toMatchObject({ revision: blocked.revision + 1 });
    for (const holder of ['firing-a', 'firing-b', 'firing-c']) {
      const answer = await next(root.nodeId, {}, holder);
      expect(answer.decision).not.toBe('revise');
    }
    expect(await next(root.nodeId, {}, 'firing-a')).toMatchObject({
      decision: 'continue',
      node: { nodeId: first.nodeId },
    });
  });

  it('revise: a wake that answers without writing is not asked again, and a fresh Revise is', async () => {
    const root = await created({ title: 'Plan 340' });
    const active = await created({ parentId: root.nodeId, title: 'P1' });
    const proposal = await created({ parentId: root.nodeId, proposed: 'Next scope' });
    await revisePlanNode(session(), {
      nodeId: proposal.nodeId,
      expectedRevision: proposal.revision,
      why: 'Name the risk.',
    });

    const first = await wake({ decisions: 1 }, 'wake-1');
    expect(first.decisions.map((d) => d.answer.decision)).toEqual(['revise']);

    // The answer's write was refused, or the wake ended first: nothing landed.
    const second = await wake({ decisions: 1 }, 'wake-2');
    expect(second.decisions).toMatchObject([
      { answer: { decision: 'continue', node: { nodeId: active.nodeId } } },
    ]);
    const third = await wake({ decisions: 1 }, 'wake-3');
    expect(third.decisions.map((d) => d.answer.decision)).not.toContain('revise');

    const again = await revisePlanNode(session(), {
      nodeId: proposal.nodeId,
      expectedRevision: (await current(proposal.nodeId)).revision,
      why: 'Name the risk and its owner.',
    });
    if (!again.ok) throw new Error(again.message);
    const fourth = await wake({ decisions: 1 }, 'wake-4');
    expect(fourth.decisions).toMatchObject([
      {
        answer: {
          decision: 'revise',
          node: {
            nodeId: proposal.nodeId,
            instructions: 'Revise: Name the risk and its owner.',
          },
        },
      },
    ]);
  });

  it('ranks a revise after a publication and before new work across the board', async () => {
    const proposal = await created({ title: 'Plan 340' });
    const finished = await created({ title: 'Plan 341' });
    await created({ title: 'Plan 342' });
    await write(proposal.nodeId, { status: 'blocked' });
    await revisePlanNode(session(), {
      nodeId: proposal.nodeId,
      expectedRevision: (await current(proposal.nodeId)).revision,
      why: 'Name the risk.',
    });
    await run(finished, PLAN_STREAM_COMMISSION_SLUG, 'completed');

    const board = await nextOnPlanBoard(streamContext(), PlanNodeNextInputSchema.parse({}));
    if (!board.ok) throw new Error(board.message);

    expect(board.output.decisions.map((d) => [d.root.title, d.answer.decision])).toEqual([
      ['Plan 341', 'publish'],
      ['Plan 340', 'revise'],
      ['Plan 342', 'continue'],
    ]);
  });
});

describe('a conversation started over REST', () => {
  /** An agent's write context, its authority read from the session state the start recorded. */
  function conversation(state: Parameters<typeof restrictedPlanWriteAuthority>[0]) {
    return {
      ...session(),
      actorKind: 'agent' as const,
      resident: restrictedPlanWriteAuthority(state),
    };
  }

  it('with a user API key creates an active node and closes its own node done', async () => {
    // As `POST /v1/sessions` records a user API key's `mcp` start (`isPersonPrincipal`).
    const ctx = conversation({ trigger: 'mcp', activatedByPerson: true });
    const made = await createPlanNode(ctx, {
      kind: 'execute',
      title: 'Approved fix',
      goal: 'g',
      criteria: 'c',
    });
    if (!made.ok) throw new Error(made.message);
    expect(made.node.status).toBe('active');

    const closed = await updatePlanNode(ctx, {
      nodeId: made.node.nodeId,
      expectedRevision: made.node.revision,
      status: 'done',
      outcome: 'Met',
    });
    expect(closed).toMatchObject({ ok: true, node: { status: 'done' } });
  });

  it('with a service principal is restricted', async () => {
    // A service principal's key stamps nothing, which the start records as false.
    const ctx = conversation({ trigger: 'mcp', activatedByPerson: false });
    expect(ctx.resident).toBe(true);
    expect(
      await createPlanNode(ctx, { kind: 'execute', title: 'Unapproved', goal: 'g', criteria: 'c' }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
    const node = await created();
    expect(
      await updatePlanNode(ctx, {
        nodeId: node.nodeId,
        expectedRevision: node.revision,
        status: 'done',
        outcome: 'Met',
      }),
    ).toMatchObject({ ok: false });
    expect((await current(node.nodeId)).status).toBe('active');
  });

  it.each([true, false, undefined])(
    'leaves a schedule session restricted whatever its stamp (%s)',
    async (activatedByPerson) => {
      const ctx = conversation({
        trigger: 'schedule',
        ...(activatedByPerson !== undefined ? { activatedByPerson } : {}),
      });
      expect(ctx.resident).toBe(true);
      expect(
        await createPlanNode(ctx, {
          kind: 'execute',
          title: 'Unapproved',
          goal: 'g',
          criteria: 'c',
        }),
      ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
    },
  );
});

describe('resident review regressions', () => {
  it('refuses active creation, approval, drop and unattested close for other scheduled sessions', async () => {
    const ctx = {
      ...session(),
      actorKind: 'agent' as const,
      resident: restrictedPlanWriteAuthority({ trigger: 'schedule', planResident: false }),
    };
    expect(
      await createPlanNode(ctx, { kind: 'execute', title: 'Unapproved', goal: 'g', criteria: 'c' }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
    const proposal = await created({ proposed: 'Needs approval' });
    expect(
      await updatePlanNode(ctx, {
        nodeId: proposal.nodeId,
        expectedRevision: proposal.revision,
        status: 'active',
      }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
    const node = await created();
    expect(
      await updatePlanNode(ctx, {
        nodeId: node.nodeId,
        expectedRevision: node.revision,
        status: 'dropped',
        outcome: 'Drop',
      }),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
    expect(
      await updatePlanNode(ctx, {
        nodeId: node.nodeId,
        expectedRevision: node.revision,
        status: 'done',
        outcome: 'Met',
      }),
    ).toMatchObject({ ok: false });
    expect((await current(node.nodeId)).status).toBe('active');
  });
  it('requires GitHub to attest the linked merge during each scheduled close', async () => {
    const root = await created();
    const node = await created({ parentId: root.nodeId });
    const read = vi.fn<(url: string) => Promise<boolean>>().mockResolvedValue(true);
    const ctx = {
      ...session(),
      actorKind: 'agent' as const,
      resident: true,
      readMergedPullRequest: read,
    };
    const input = {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      status: 'done' as const,
      outcome: 'Met',
    };
    expect(await updatePlanNode(ctx, input)).toMatchObject({
      ok: false,
      message: expect.stringContaining('linked pull request'),
    });
    expect(read).not.toHaveBeenCalled();
    input.expectedRevision = (await current(node.nodeId)).revision;
    await linkPlanNode(session(), { nodeId: node.nodeId, kind: 'pull_request', ref: PR });
    await linkPlanNode(session(), { nodeId: node.nodeId, kind: 'merge', ref: PR });
    read.mockResolvedValue(false);
    expect(await updatePlanNode(ctx, input)).toMatchObject({ ok: false });
    expect(await current(node.nodeId)).toMatchObject({
      status: 'active',
      note: expect.stringContaining('Waiting on you:'),
    });
    read.mockRejectedValueOnce(new Error('GitHub unavailable'));
    expect(await updatePlanNode(ctx, input)).toMatchObject({ ok: false });
    expect(await updatePlanNode({ ...session(), resident: true }, input)).toMatchObject({
      ok: false,
    });
    read.mockResolvedValue(true);
    expect(await updatePlanNode(ctx, input)).toMatchObject({ ok: true, node: { status: 'done' } });
    expect(read).toHaveBeenLastCalledWith(PR, node.nodeId);
  });

  it('retries failed attestation on a later wake without a wait line or person routing', async () => {
    const node = await created();
    const read = vi.fn().mockRejectedValueOnce(new Error('GitHub timeout')).mockResolvedValue(true);
    const wake = {
      ...session(),
      actorKind: 'agent' as const,
      resident: true,
      readMergedPullRequest: read,
    };
    await linkPlanNode(wake, { nodeId: node.nodeId, kind: 'pull_request', ref: PR });
    const input = {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      status: 'done' as const,
      outcome: 'Met',
    };
    expect(await updatePlanNode(wake, input)).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_ATTESTATION_UNAVAILABLE',
    });
    expect(await current(node.nodeId)).toEqual(node);
    expect(await listWaitingNodes(wake)).toEqual([]);
    expect(await updatePlanNode(wake, input)).toMatchObject({ ok: true, node: { status: 'done' } });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('closes record_merge with the resident own link and asks once when attestation refuses', async () => {
    const node = await created();
    const read = vi.fn().mockResolvedValue(false);
    const wake = {
      ...session(),
      actorKind: 'agent' as const,
      resident: true,
      readMergedPullRequest: read,
    };
    await linkPlanNode(wake, { nodeId: node.nodeId, kind: 'pull_request', ref: PR });
    const close = () =>
      updatePlanNode(wake, {
        nodeId: node.nodeId,
        expectedRevision: store.nodes.get(node.nodeId)!.revision,
        status: 'done',
        outcome: 'The merge meets the criteria.',
      });
    expect(await close()).toMatchObject({ ok: false });
    const waiting = await current(node.nodeId);
    expect(await listWaitingNodes(wake)).toContainEqual(waiting);
    const record = await redis.get(askedKey(TENANT, SPACE, node.nodeId));
    expect(await close()).toMatchObject({ ok: false });
    expect((await current(node.nodeId)).revision).toBe(waiting.revision);
    expect(await redis.get(askedKey(TENANT, SPACE, node.nodeId))).toBe(record);
    await write(node.nodeId, { note: waiting.note + '\nOperator context' });
    const changed = await current(node.nodeId);
    expect(
      await nextOnPlanBoard(
        { ...wake, holder: 'wake-after-person', reads: reads() },
        PlanNodeNextInputSchema.parse({}),
      ),
    ).toMatchObject({ ok: true, output: { decisions: [{ answer: { decision: 'ask' } }] } });
    expect(await redis.get(askedKey(TENANT, SPACE, node.nodeId))).toBe(String(changed.revision));
    read.mockResolvedValue(true);
    expect(await close()).toMatchObject({ ok: true, node: { status: 'done' } });
    expect(await listWaitingNodes(wake)).toEqual([]);
  });

  it('rejects a merged pull request that does not deliver the node work', async () => {
    const node = await created();
    const read = vi.fn<(url: string) => Promise<boolean>>().mockResolvedValue(false);
    const wake = {
      ...session(),
      actorKind: 'agent' as const,
      resident: true,
      readMergedPullRequest: read,
    };
    await linkPlanNode(wake, { nodeId: node.nodeId, kind: 'pull_request', ref: PR });
    expect(
      await updatePlanNode(wake, {
        nodeId: node.nodeId,
        expectedRevision: node.revision,
        status: 'done',
        outcome: 'Met',
      }),
    ).toMatchObject({ ok: false });
    expect(read).toHaveBeenCalledWith(PR, node.nodeId);
    expect(await current(node.nodeId)).toMatchObject({
      status: 'active',
      note: expect.stringContaining('Waiting on you:'),
    });
  });

  it('keeps an early merge link unjudged and waits on a person after refusal', async () => {
    const { root, first } = await stream();
    const mergedAt = await publishedRound(first);
    await linkPlanNode(
      { ...session(), resident: true },
      { nodeId: first.nodeId, kind: 'merge', ref: PR },
    );
    expect(await fire(root.nodeId, (url) => merged(url, mergedAt))).toMatchObject({
      decision: 'record_merge',
    });
    const ctx = { ...session(), resident: true, readMergedPullRequest: async () => false };
    expect(
      await updatePlanNode(ctx, {
        nodeId: first.nodeId,
        expectedRevision: first.revision,
        status: 'done',
        outcome: 'Met',
      }),
    ).toMatchObject({ ok: false });
    const waiting = await current(first.nodeId);
    expect(waiting).toMatchObject({
      status: 'active',
      note: expect.stringContaining('Waiting on you:'),
    });
    expect(await redis.get(askedKey(TENANT, SPACE, first.nodeId))).toBe(String(waiting.revision));
    expect(await listWaitingNodes({ ...session(), redis, tenantId: TENANT })).toContainEqual(
      waiting,
    );
    expect(await fire(root.nodeId, (url) => merged(url, mergedAt))).toMatchObject({
      decision: 'wait',
    });
  });

  it('blocks a refused close with a full note so the existing ask flow can raise it', async () => {
    const node = await created();
    await write(node.nodeId, { note: 'x'.repeat(PLAN_NODE_PROSE_MAX_CHARS) });
    const full = await current(node.nodeId);
    expect(
      await updatePlanNode(
        { ...session(), resident: true },
        {
          nodeId: full.nodeId,
          expectedRevision: full.revision,
          status: 'done',
          outcome: 'Met',
        },
      ),
    ).toMatchObject({ ok: false });
    expect(await current(node.nodeId)).toMatchObject({ status: 'blocked', note: full.note });
    expect(await redis.get(askedKey(TENANT, SPACE, node.nodeId))).toBe(
      String((await current(node.nodeId)).revision),
    );
  });

  it('does not propose earlier findings again after the closed node moves', async () => {
    const root = await created();
    const other = await created();
    const node = await created({ parentId: root.nodeId });
    await linkPlanNode(session(), { nodeId: node.nodeId, kind: 'finding', ref: 'carried' });
    expect(
      await updatePlanNode(session(), {
        nodeId: node.nodeId,
        expectedRevision: node.revision,
        status: 'done',
        outcome: 'Met',
      }),
    ).toMatchObject({ ok: true, carrier: { status: 'blocked' } });
    await write(node.nodeId, { status: 'active', parentId: other.nodeId });
    const reopened = await current(node.nodeId);
    expect(
      await updatePlanNode(session(), {
        nodeId: node.nodeId,
        expectedRevision: reopened.revision,
        status: 'done',
        outcome: 'Met',
      }),
    ).toMatchObject({ ok: true });
    expect(store.nodes.size).toBe(4);
  });

  it('closes from GitHub without an earlier merge record and preserves concurrent person writes', async () => {
    const root = await created();
    const node = await created({ parentId: root.nodeId });
    await linkPlanNode(session(), { nodeId: node.nodeId, kind: 'pull_request', ref: PR });
    const input = {
      nodeId: node.nodeId,
      expectedRevision: node.revision,
      status: 'done' as const,
      outcome: 'Met',
    };
    expect(
      await updatePlanNode(
        {
          ...session(),
          resident: true,
          readMergedPullRequest: async () => {
            await write(node.nodeId, { note: 'Person changed this step' });
            return true;
          },
        },
        input,
      ),
    ).toMatchObject({ ok: false, code: 'PLAN_NODE_STALE' });
    expect(await current(node.nodeId)).toMatchObject({
      status: 'active',
      note: 'Person changed this step',
    });
    expect(
      await updatePlanNode(
        { ...session(), resident: true, readMergedPullRequest: async () => true },
        {
          ...input,
          expectedRevision: (await current(node.nodeId)).revision,
        },
      ),
    ).toMatchObject({ ok: true });
  });

  it.each(['human', 'agent'] as const)(
    'preserves %s conversation closes without merge reads',
    async (actorKind) => {
      const node = await created();
      const read = vi.fn<(url: string) => Promise<boolean>>();
      expect(
        await updatePlanNode(
          { ...session(), actorKind, resident: false, readMergedPullRequest: read },
          {
            nodeId: node.nodeId,
            expectedRevision: node.revision,
            status: 'done',
            outcome: 'Met',
          },
        ),
      ).toMatchObject({ ok: true });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('refuses scheduled reparenting and position changes without writing', async () => {
    const root = await created();
    const closed = await created();
    await write(closed.nodeId, { status: 'done', outcome: 'Met' });
    for (const node of [
      root,
      await created({ parentId: root.nodeId }),
      await created({ proposed: 'Scope' }),
    ]) {
      for (const patch of [{ parentId: closed.nodeId }, { parentId: null }, { position: 0 }]) {
        expect(
          await updatePlanNode(
            { ...session(), resident: true },
            {
              nodeId: node.nodeId,
              expectedRevision: node.revision,
              ...patch,
            },
          ),
        ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
        expect(await current(node.nodeId)).toEqual(node);
      }
    }
  });

  it('reads one carrier timestamp without sibling rows or per-sibling finds', async () => {
    const node = await created();
    for (let i = 0; i < 105; i++) store.seed(SPACE, { status: 'done' });
    await linkPlanNode(session(), { nodeId: node.nodeId, kind: 'finding', ref: 'F-bounded' });
    const siblings = vi.spyOn(store, 'listChildren');
    const find = vi.spyOn(store, 'find');
    const timestamp = vi.spyOn(store, 'latestCarrierAt');
    expect(
      await updatePlanNode(session(), {
        nodeId: node.nodeId,
        expectedRevision: node.revision,
        status: 'done',
        outcome: 'Met',
      }),
    ).toMatchObject({ ok: true, carrier: { status: 'blocked' } });
    expect(siblings).not.toHaveBeenCalled();
    expect(find).toHaveBeenCalledTimes(1);
    expect(timestamp).toHaveBeenCalledExactlyOnceWith(SPACE, node.nodeId);
  });

  it('leaves an over-ceiling completed operator commission with its publishing conversation', async () => {
    const { root, first } = await stream();
    store.nodes.set(first.nodeId, { ...first, spendCents: 500 });
    const runId = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed', { cents: 600 });
    operatorCommissions.add(runId);
    expect(await next(root.nodeId)).toMatchObject({
      decision: 'wait',
      cause: 'awaiting_publication',
    });
  });

  it('keeps the spend window on a human update; only the open route resets it', async () => {
    const { root, first } = await stream();
    store.nodes.set(first.nodeId, { ...first, spendCents: 500 });
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'failed', { cents: 600, failure: 'x' });
    const blocked = await write(first.nodeId, { status: 'blocked' });
    await updatePlanNode(
      { ...session(), actorKind: 'human' },
      {
        nodeId: first.nodeId,
        expectedRevision: blocked.revision,
        status: 'active',
      },
    );
    expect(store.openedAt.has(first.nodeId)).toBe(false);
    expect(await next(root.nodeId, { attempts: 10 })).toMatchObject({ cause: 'spend_spent' });
  });
  it('reserves room for new work despite three open pull requests', async () => {
    for (let i = 0; i < 3; i += 1) {
      const { first } = await stream();
      await publishedRound(first);
    }
    const fresh = await stream();
    const board = await wake({ decisions: 3 });
    expect(board.decisions).toHaveLength(3);
    expect(board.decisions).toContainEqual(
      expect.objectContaining({
        root: expect.objectContaining({ nodeId: fresh.root.nodeId }),
        answer: expect.objectContaining({ decision: 'continue' }),
      }),
    );
  });

  it('claims one publication across simultaneous board and root firings', async () => {
    const { root, first } = await stream();
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed');
    const answers = await Promise.all([next(root.nodeId, {}, 'root-wake'), wake({}, 'board-wake')]);
    const decisions = answers.flatMap((answer) =>
      'decisions' in answer ? answer.decisions.map((d) => d.answer) : [answer],
    );
    expect(decisions.filter((answer) => answer.decision === 'publish')).toHaveLength(1);
  });

  it.each(['write', 'resume'] as const)(
    'starts fresh after %s supersedes an operator commission',
    async (path) => {
      const { root, first } = await stream();
      const runId = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed');
      operatorCommissions.add(runId);
      expect(await next(root.nodeId)).toMatchObject({ cause: 'awaiting_publication' });
      if (path === 'resume') {
        await write(first.nodeId, { status: 'blocked' });
        const blocked = await current(first.nodeId);
        await openPlanNode(session(), { nodeId: first.nodeId, expectedRevision: blocked.revision });
      } else {
        await write(first.nodeId, { note: 'Take a fresh approach.' });
      }
      expect(await next(root.nodeId)).toMatchObject({ decision: 'continue' });
    },
  );

  it('leaves an operator conversation commission to its owner', async () => {
    const { root, first } = await stream();
    const runId = await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed');
    operatorCommissions.add(runId);
    const board = await wake();
    expect(board.decisions).toEqual([]);
    expect(board.waits).toEqual([{ cause: 'awaiting_publication', roots: 1 }]);
    expect(await next(root.nodeId)).toMatchObject({
      decision: 'wait',
      cause: 'awaiting_publication',
    });
  });
});

describe('settled P2 rules', () => {
  it('refuses resident reopening of blocked, done and dropped scope', async () => {
    for (const status of ['blocked', 'done', 'dropped'] as const) {
      const node = await created({ proposed: 'Person decides' });
      if (status !== 'blocked') await write(node.nodeId, { status, outcome: 'Closed' });
      const before = await current(node.nodeId);
      expect(
        await openPlanNode(
          { ...session(), resident: true },
          {
            nodeId: node.nodeId,
            expectedRevision: before.revision,
          },
        ),
      ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
      expect(await current(node.nodeId)).toEqual(before);
    }
  });

  it.each(['execute', 'investigate', 'decide'] as const)(
    'refuses resident done, dropped and repeated closes of person scope (%s)',
    async (kind) => {
      for (const status of ['active', 'blocked', 'done', 'dropped'] as const) {
        const node = await created({ kind });
        if (status !== 'active')
          await write(node.nodeId, {
            status,
            ...(status === 'blocked' ? {} : { outcome: 'Closed' }),
          });
        const before = await current(node.nodeId);
        for (const close of ['done', 'dropped'] as const) {
          expect(
            await updatePlanNode(
              { ...session(), resident: true },
              {
                nodeId: node.nodeId,
                expectedRevision: (await current(node.nodeId)).revision,
                status: close,
                outcome: 'Agent closes',
              },
            ),
          ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
        }
        expect(await current(node.nodeId)).toMatchObject({ status: before.status });
        if (status === 'active')
          expect((await current(node.nodeId)).note).toContain('Waiting on you:');
        else expect(await current(node.nodeId)).toEqual(before);
      }
    },
  );

  it('refuses resident scope rewrites on person-approved and blocked-proposal nodes', async () => {
    for (const proposed of [undefined, 'Needs approval']) {
      const node = await created(proposed ? { proposed } : {});
      for (const field of ['title', 'goal', 'criteria'] as const) {
        expect(
          await updatePlanNode(
            { ...session(), resident: true },
            {
              nodeId: node.nodeId,
              expectedRevision: node.revision,
              [field]: 'Widened',
            },
          ),
        ).toMatchObject({ ok: false, code: 'PLAN_NODE_RESIDENT_SCOPE' });
      }
      await write(node.nodeId, { note: 'Person wrote' });
      expect(
        await updatePlanNode(
          { ...session(), resident: true },
          {
            nodeId: node.nodeId,
            expectedRevision: node.revision,
            goal: 'Race',
          },
        ),
      ).toMatchObject({ ok: false, code: 'PLAN_NODE_STALE' });
    }
  });

  it('preserves operator notes when appending waits at and near the prose ceiling', async () => {
    for (const length of [10, PLAN_NODE_PROSE_MAX_CHARS - 2, PLAN_NODE_PROSE_MAX_CHARS]) {
      const note = 'x'.repeat(length);
      const node = await created({ note });
      const ask = planAsk({ ...node, status: 'blocked' });
      expect(ask.waitsOn).toContain('Waiting on you:');
      if (ask.update) {
        expect(ask.update.note).toBe(note + '\n' + ask.waitsOn);
        expect(ask.update.note!.length).toBeLessThanOrEqual(PLAN_NODE_PROSE_MAX_CHARS);
      } else expect((await current(node.nodeId)).note).toBe(note);
    }
  });

  it('asks once across ten wakes at the same revision', async () => {
    const node = await created({ note: 'Operator context' });
    await write(node.nodeId, { status: 'blocked' });
    // Listed before any wake has asked (Plan 338 D1); the wake still writes its line once.
    expect(await listWaitingNodes(streamContext('ask-read'))).toMatchObject([
      { nodeId: node.nodeId },
    ]);
    let revision: number | undefined;
    for (let i = 0; i < 10; i++) {
      const result = await wake({}, 'wake-' + String(i));
      expect(result.decisions.filter((d) => d.answer.decision === 'ask')).toHaveLength(
        i === 0 ? 1 : 0,
      );
      const answer = result.decisions[0]?.answer;
      if (answer?.decision === 'ask' && answer.update) {
        expect((await updatePlanNode(session(), answer.update)).ok).toBe(true);
        revision = (await current(node.nodeId)).revision;
      }
      expect(await listWaitingNodes(streamContext('ask-read'))).toHaveLength(1);
      expect((await current(node.nodeId)).revision).toBe(revision);
      expect((await current(node.nodeId)).note?.split('Waiting on you:')).toHaveLength(2);
    }
  });

  it('withholds proposals for actionable or candidate-root waiting work but ignores unrelated waits', async () => {
    const root = await created();
    const child = await created({ parentId: root.nodeId });
    await write(child.nodeId, { status: 'done', outcome: 'Met' });
    const held = await created({ parentId: root.nodeId, proposed: 'Wait' });
    expect(await wake()).not.toHaveProperty('propose');
    await write(held.nodeId, { status: 'waiting' });
    expect(await wake()).not.toHaveProperty('propose');
    await write(held.nodeId, { status: 'done', outcome: 'Met' });
    const actionable = await created();
    const deferred = await created();
    const capped = await wake({ decisions: 1 });
    expect(capped).not.toHaveProperty('propose');
    expect(capped.deferred).toBe(1);
    await write(actionable.nodeId, { status: 'blocked', note: 'Waiting on you: approve' });
    await write(deferred.nodeId, { status: 'blocked', note: 'Waiting on you: approve' });
    const asks = await wake();
    expect(asks.decisions.every((decision) => decision.answer.decision === 'ask')).toBe(true);
    expect(asks).toMatchObject({ propose: { parentId: root.nodeId } });
    expect(await wake()).toMatchObject({ propose: { parentId: root.nodeId } });
  });

  it('ignores closed history beyond the candidate-root walk limit without forgetting its decline', async () => {
    const root = await created();
    const children = vi.spyOn(store, 'listChildren');
    const walk = vi.spyOn(store, 'walk');
    for (let i = 0; i < PLAN_TREE_WALK_NODE_LIMIT + 5; i++) {
      store.seed(SPACE, { parentId: root.nodeId, status: 'done' });
    }
    expect(await wake()).toMatchObject({ decisions: [], propose: { parentId: root.nodeId } });
    expect(children.mock.calls.length).toBeLessThan(10);
    expect(
      walk.mock.calls.every(([, bounds]) => bounds.maxNodes <= PLAN_TREE_WALK_NODE_LIMIT),
    ).toBe(true);
    const declined = await created({ parentId: root.nodeId, proposed: 'Next scope' });
    await write(declined.nodeId, { status: 'dropped', outcome: 'Declined' });
    expect(await wake()).not.toHaveProperty('propose');
  });

  it('finds existing carriers beyond the first sibling page including root siblings', async () => {
    for (const rooted of [false, true]) {
      const parent = rooted ? await created() : null;
      const node = await created({ parentId: parent?.nodeId ?? null });
      for (let i = 0; i < 105; i++) store.seed(SPACE, { parentId: node.parentId, status: 'done' });
      await linkPlanNode(session(), { nodeId: node.nodeId, kind: 'finding', ref: 'F1' });
      const first = await updatePlanNode(session(), {
        nodeId: node.nodeId,
        expectedRevision: node.revision,
        status: 'done',
        outcome: 'Met',
      });
      if (!first.ok || !first.carrier) throw new Error('Missing carrier');
      await write(node.nodeId, { status: 'active' });
      const again = await updatePlanNode(session(), {
        nodeId: node.nodeId,
        expectedRevision: (await current(node.nodeId)).revision,
        status: 'done',
        outcome: 'Met again',
      });
      expect(again).toMatchObject({ ok: true });
      expect(again).not.toHaveProperty('carrier');
    }
  });

  it.each(['execute', 'decide'] as const)(
    'keeps close successful and retries or records carrier read, insert and publish failures (%s)',
    async (kind) => {
      for (const stage of ['read', 'insert', 'refusal', 'publish'] as const) {
        const logged = vi
          .spyOn(runtimeLogger, 'logCyberneticError')
          .mockImplementation(() => undefined);
        const node = await created({ kind });
        await linkPlanNode(session(), { nodeId: node.nodeId, kind: 'finding', ref: 'F-failed' });
        if (stage === 'read')
          vi.spyOn(store, 'pageLinks').mockRejectedValueOnce(new Error('read failed'));
        if (stage === 'insert')
          vi.spyOn(store, 'insert').mockRejectedValueOnce(new Error('insert failed'));
        if (stage === 'refusal')
          vi.spyOn(store, 'insert').mockResolvedValueOnce({ outcome: 'parent_not_found' });
        if (stage === 'publish') {
          const insert = store.insert.bind(store);
          vi.spyOn(store, 'insert').mockImplementationOnce(async (...args) => {
            const inserted = await insert(...args);
            vi.spyOn(redis, 'publish').mockImplementationOnce(() => {
              throw new Error('publish failed');
            });
            return inserted;
          });
        }
        const result = await updatePlanNode(
          { ...session(), actorKind: 'human' },
          {
            nodeId: node.nodeId,
            expectedRevision: node.revision,
            status: 'done',
            outcome: 'Met',
          },
        );
        expect(result).toMatchObject({
          ok: true,
          carrierFailure: expect.stringContaining(node.nodeId),
        });
        expect(result).toMatchObject({
          carrierFailure: expect.stringContaining('linked findings'),
        });
        expect(logged).toHaveBeenLastCalledWith(
          expect.stringContaining('Recover the findings'),
          expect.any(Error),
          expect.objectContaining({
            nodeId: node.nodeId,
            findings: { nodeId: node.nodeId, kind: 'finding' },
          }),
        );
        expect((await current(node.nodeId)).status).toBe('done');
        expect(
          store.links.some((link) => link.nodeId === node.nodeId && link.ref === 'F-failed'),
        ).toBe(true);
        vi.restoreAllMocks();
      }
    },
  );

  it('refuses live-check completion and read attestation by resident, chat and voice agents', async () => {
    const node = await created({
      kind: 'investigate',
      liveCheck: { pullRequest: PR, mergeCommitSha: MERGE_SHA },
    });
    for (const writer of ['resident', 'chat', 'voice']) {
      const ctx = { ...session(), actorKind: 'agent' as const, resident: writer === 'resident' };
      for (const patch of [
        { status: 'active' as const },
        { status: 'waiting' as const },
        { status: 'done' as const, outcome: 'Read' },
        { note: 'I read the folder head' },
        { outcome: 'Read' },
      ]) {
        expect(
          (
            await updatePlanNode(ctx, {
              nodeId: node.nodeId,
              expectedRevision: node.revision,
              ...patch,
            })
          ).ok,
        ).toBe(false);
      }
      expect(
        (await openPlanNode(ctx, { nodeId: node.nodeId, expectedRevision: node.revision })).ok,
      ).toBe(false);
    }
    expect(await current(node.nodeId)).toEqual(node);
  });
});

describe('round 13 root movement', () => {
  it('withholds proposals for paused attention beneath a done child', async () => {
    const root = await created();
    const child = await created({ parentId: root.nodeId });
    const grandchild = await created({ parentId: child.nodeId });
    const paused = await run(grandchild, PLAN_STREAM_COMMISSION_SLUG, 'completed');
    pausedItemRuns.push(paused);
    await write(grandchild.nodeId, { status: 'done', outcome: 'Done' });
    await write(child.nodeId, { status: 'done', outcome: 'Done' });
    expect(await next(root.nodeId)).toMatchObject({ decision: 'wait', cause: 'in_flight' });
    const held = await wake();
    expect(held.propose).toBeUndefined();
    expect(held).toMatchObject({
      decisions: [],
      waits: [{ cause: 'in_flight', roots: 1 }],
    });
    pausedItemRuns = [];
    expect(await wake()).toMatchObject({ propose: { parentId: root.nodeId } });
  });

  it('holds an exhausted root while a run serves a done child', async () => {
    const root = await created();
    const child = await created({ parentId: root.nodeId });
    await run(child, PLAN_STREAM_COMMISSION_SLUG, 'running');
    await write(child.nodeId, { status: 'done', outcome: 'Done' });
    expect(await next(root.nodeId)).toMatchObject({ decision: 'wait', cause: 'in_flight' });
    expect(await wake()).toMatchObject({
      decisions: [],
      waits: [{ cause: 'in_flight', roots: 1 }],
    });
  });
});

it('keeps the stream module documentation before its imports', () => {
  const source = readFileSync(new URL('../plan/stream.ts', import.meta.url), 'utf8');
  expect(source.startsWith('/**')).toBe(true);
  expect(source.indexOf('import { isFindingsCarrier }')).toBeGreaterThan(source.indexOf('*/'));
});

describe('model-free board previews', () => {
  it('waits for work another wake has already claimed', async () => {
    await stream();
    await wake({}, 'other-wake');
    const result = await nextOnPlanBoard(
      { ...streamContext('due-check'), preview: true },
      PlanNodeNextInputSchema.parse({}),
    );
    expect(result.ok && result.output.decisions).toEqual([]);
  });
  it('leaves a blocked node unasked until a model wake claims it', async () => {
    const { first } = await stream();
    await write(first.nodeId, { status: 'blocked' });
    const result = await nextOnPlanBoard(
      { ...streamContext('due-check'), preview: true },
      PlanNodeNextInputSchema.parse({}),
    );
    expect(result.ok && result.output.decisions[0]?.answer.decision).toBe('ask');
    expect((await wake({}, 'model-wake')).decisions[0]?.answer.decision).toBe('ask');
  });
  it('leaves actionable work and asks for the wake to claim', async () => {
    await stream();
    const result = await nextOnPlanBoard(
      { ...streamContext('due-check'), preview: true },
      PlanNodeNextInputSchema.parse({}),
    );
    expect(result.ok && result.output.decisions.length).toBeGreaterThan(0);
    expect((await wake({}, 'model-wake')).decisions.length).toBeGreaterThan(0);
  });
});
