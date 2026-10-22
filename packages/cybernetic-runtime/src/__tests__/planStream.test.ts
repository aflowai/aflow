import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  PLAN_NODE_LINKS_LIMIT,
  PLAN_STREAM_ATTEMPTS_DEFAULT,
  PLAN_STREAM_COMMISSION_SLUG,
  PLAN_STREAM_PUBLICATION_SLUG,
  PLAN_TREE_DEPTH_LIMIT,
  PLAN_TREE_WALK_NODE_LIMIT,
  PlanNodeNextInputSchema,
  PlanNodeNextOutputSchema,
  type PlanNode,
  type PlanNodeCreateInput,
  type PlanNodeNextOutput,
  type PlanStreamPullRequestAnswer,
} from '@aflow/schemas';
import {
  createPlanNode,
  getPlanNode,
  linkEndedRun,
  linkPlanNode,
  updatePlanNode,
  type PlanWriteContext,
} from '../plan/operations.js';
import {
  findActiveStreamNode,
  mergeNoteHead,
  nextInPlanStream,
  type PlanPublicationOutcome,
  type PlanStreamReads,
} from '../plan/stream.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const TENANT = 'a0000000-0000-4000-8000-000000000322';
const SPACE = '5e1d0000-0000-4000-8000-000000000322';
const PR = 'https://github.com/aflowai/aflow/pull/160';
const MERGE_SHA = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';

let store: InMemoryPlanNodeStore;
let redis: RedisType;
let outcomes: Map<string, PlanPublicationOutcome | null>;
let failures: Map<string, string>;
let pausedItemRuns: string[];
let lastStamp: number;
let runSeq: number;

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
            ...(failures.has(r.runId) ? { failure: failures.get(r.runId)! } : {}),
          })),
      ),
    publicationOutcome: (_spaceId, runId) => Promise.resolve(outcomes.get(runId) ?? null),
    pausedItemsServing: (_spaceId, nodeIds) =>
      Promise.resolve(
        pausedItemRuns.filter((runId) =>
          store.runs.some((r) => r.runId === runId && nodeIds.includes(r.nodeId)),
        ).length,
      ),
  };
}

function session(): PlanWriteContext {
  return { store, redis, tenantId: TENANT, spaceId: SPACE, createdBy: 'operator' };
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
  opts: { failure?: string; outcome?: PlanPublicationOutcome | null } = {},
): Promise<string> {
  runSeq += 1;
  const runId = `${slug}-${String(runSeq)}`;
  store.runs.push({ runId, slug, status, nodeId: node.nodeId, spaceId: SPACE, startedAt: stamp() });
  if (opts.failure !== undefined) failures.set(runId, opts.failure);
  if (opts.outcome !== undefined) outcomes.set(runId, opts.outcome);
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
): Promise<PlanNodeNextOutput> {
  const input = PlanNodeNextInputSchema.parse({ rootNodeId, ...extra });
  const result = await nextInPlanStream(streamContext(holder), input);
  if (!result.ok) throw new Error(result.message);
  expect(PlanNodeNextOutputSchema.safeParse(result.output).success).toBe(true);
  return result.output;
}

/** A firing that reads the pull request when asked, as GitHub answers it. */
async function fire(
  rootNodeId: string,
  github?: (url: string) => PlanStreamPullRequestAnswer,
  attempts?: number,
): Promise<PlanNodeNextOutput> {
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

  it('waits on a commission that completed with no publication yet', async () => {
    const { root, first } = await stream();
    await run(first, PLAN_STREAM_COMMISSION_SLUG, 'completed');
    expect(await fire(root.nodeId)).toMatchObject({
      decision: 'wait',
      cause: 'awaiting_publication',
    });
  });

  it('refuses a root that is not in the space', async () => {
    const result = await nextInPlanStream(
      streamContext(),
      PlanNodeNextInputSchema.parse({ rootNodeId: '5e1d0000-0000-4000-8000-00000000dead' }),
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
    const mergedAt = await publishedRound(first);
    const github = (url: string) => merged(url, mergedAt);

    const record = await fire(root.nodeId, github);
    expect(record).toMatchObject({
      decision: 'record_merge',
      node: { nodeId: first.nodeId, criteria: first.criteria },
      pullRequest: { url: PR, mergedAt, mergeCommitSha: MERGE_SHA },
    });
    await write(first.nodeId, { status: 'done', outcome: `Met by ${PR}, merged as ${MERGE_SHA}.` });

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
