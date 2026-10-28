/**
 * The space's plan as the operator reads it: the plans as rows with their
 * state (Plan 332 D3, D7), and one plan as its board (Plan 322 P3.3, scoped to
 * one root by Plan 332 D7) — every status, each node nested under its parent in sibling order with
 * its card's facts — counts in place of links, rounds, activity, newest pull
 * request, a parent's progress — each plan's tallies and done nodes by day,
 * and a done window applied on the server. And one node for the rail, its
 * links paged by an opaque cursor.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  PLAN_NODE_GOAL_HEAD_MAX_CHARS,
  PLAN_NODE_NOTE_HEAD_MAX_CHARS,
  PLAN_TREE_DEPTH_LIMIT,
  PLAN_TREE_WALK_NODE_LIMIT,
  PlanNodeDetailOutputSchema,
  PlanNodeDetailQuerySchema,
  PlanBoardOutputSchema,
  PlanOverviewOutputSchema,
  planBoardCards,
  planBoardColumn,
  type PlanNode,
  type PlanNodeCreateInput,
  type PlanNodeSummary,
  type PlanTreeNode,
} from '@aflow/schemas';
import {
  createPlanNode,
  linkPlanNode,
  readPlanNodeDetail,
  PLAN_TREE_WALK_BOUNDS,
  readPlanBoard,
  readPlanOverview,
  updatePlanNode,
  type PlanWriteContext,
} from '../plan/operations.js';
import {
  buildPlanBoard,
  decodePlanLinkCursor,
  encodePlanLinkCursor,
  planDayReader,
  planRootState,
  type PlanBoardOptions,
} from '../plan/board.js';
import { planGoalHead } from '../plan/store.js';
import { findActiveStreamNode, mergeLinkLabel } from '../plan/stream.js';
import { orderPlanTree } from '../plan/tree.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const TENANT = 'a0000000-0000-4000-8000-000000000322';
const SPACE = '5e1d0000-0000-4000-8000-000000000322';
const OTHER_SPACE = '5e1d0000-0000-4000-8000-000000000999';
const PR = 'https://github.com/aflowai/aflow/pull/181';
const OLDER_PR = 'https://github.com/aflowai/aflow/pull/170';

let store: InMemoryPlanNodeStore;
let redis: RedisType;

function ctx(spaceId = SPACE): PlanWriteContext {
  return { store, redis, tenantId: TENANT, spaceId };
}

async function node(
  title: string,
  input: Partial<PlanNodeCreateInput> = {},
  spaceId = SPACE,
): Promise<PlanNode> {
  const result = await createPlanNode(ctx(spaceId), {
    kind: 'execute',
    title,
    goal: `Goal of ${title}.`,
    criteria: `Criteria of ${title}.`,
    ...input,
  });
  if (!result.ok) throw new Error(result.message);
  return result.node;
}

async function close(at: PlanNode, status: 'done' | 'dropped'): Promise<void> {
  const result = await updatePlanNode(ctx(), {
    nodeId: at.nodeId,
    expectedRevision: at.revision,
    status,
    outcome: `${status} ${at.title}.`,
  });
  if (!result.ok) throw new Error(result.message);
}

/** Counts the `Intl.DateTimeFormat`s built until `restore`. */
function countDayFormatters(): { readonly count: number; restore: () => void } {
  const real = Intl.DateTimeFormat;
  let count = 0;
  Intl.DateTimeFormat = new Proxy(real, {
    construct(target, args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      count++;
      return new target(...args);
    },
  });
  return {
    get count() {
      return count;
    },
    restore: () => {
      Intl.DateTimeFormat = real;
    },
  };
}

async function rows() {
  // What the route serializes: the engine's answer must be the schema's.
  return PlanOverviewOutputSchema.parse(await readPlanOverview({ store, spaceId: SPACE }));
}

async function board(rootId: string, opts: PlanBoardOptions = {}) {
  const result = await readPlanBoard({ store, spaceId: SPACE }, rootId, opts);
  if (!result.ok) throw new Error(result.message);
  const { ok: _ok, ...read } = result;
  return PlanBoardOutputSchema.parse(read);
}

/** Every plan's board, read one root at a time in the rows' order. */
async function read(opts: PlanBoardOptions = {}) {
  const boards = await Promise.all((await rows()).roots.map((r) => board(r.nodeId, opts)));
  const truncated = boards.find((b) => b.truncated !== undefined)?.truncated;
  return {
    roots: boards.map((b) => b.root),
    tallies: boards.map((b) => b.tally),
    ...(truncated !== undefined ? { truncated } : {}),
  };
}

function titles(trees: readonly PlanTreeNode[]): unknown[] {
  return trees.map((t) => (t.children.length === 0 ? t.title : { [t.title]: titles(t.children) }));
}

function find(trees: readonly PlanTreeNode[], nodeId: string): PlanTreeNode | undefined {
  for (const tree of trees) {
    if (tree.nodeId === nodeId) return tree;
    const below = find(tree.children, nodeId);
    if (below) return below;
  }
  return undefined;
}

function inFlightRun(runId: string, nodeId: string, status: string) {
  return {
    runId,
    slug: 'commission-change',
    status,
    nodeId,
    spaceId: SPACE,
    startedAt: '2026-10-05T08:00:00.000Z',
  };
}

beforeEach(async () => {
  store = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

describe('readPlanBoard — one plan as its board', () => {
  it('reads an empty plan as no roots and no tallies', async () => {
    expect(await read()).toEqual({ roots: [], tallies: [] });
  });

  it('nests every node under its parent, roots and siblings by position, whatever their status', async () => {
    const second = await node('second root', { position: 5 });
    const first = await node('first root', { position: 1 });
    const later = await node('later', { parentId: first.nodeId, position: 2 });
    await node('earlier', { parentId: first.nodeId, position: 0 });
    await node('under later', { parentId: later.nodeId });
    await close(await node('dropped', { parentId: second.nodeId }), 'dropped');
    await node('elsewhere', {}, OTHER_SPACE);

    const trees = await read();

    expect(titles(trees.roots)).toEqual([
      { 'first root': ['earlier', { later: ['under later'] }] },
      { 'second root': ['dropped'] },
    ]);
    expect(trees.tallies.map((t) => t.rootId)).toEqual([first.nodeId, second.nodeId]);
    expect(trees).not.toHaveProperty('truncated');
  });

  it('carries no links, runs, outcome or prose: counts, the goal’s head, and when it was made and closed', async () => {
    const long = 'g'.repeat(PLAN_NODE_GOAL_HEAD_MAX_CHARS + 40);
    const done = await node('done', { goal: long });
    await close(done, 'done');

    const [tree] = (await read()).roots;

    expect(tree).not.toHaveProperty('links');
    expect(tree).not.toHaveProperty('runs');
    expect(tree).not.toHaveProperty('outcome');
    expect(tree?.goalHead).toBe(long.slice(0, PLAN_NODE_GOAL_HEAD_MAX_CHARS));
    expect(tree?.createdAt).toBe(done.createdAt);
    expect(tree?.closedAt).toEqual(expect.any(String));
  });

  it('cuts a goal’s head by code points within the schema’s limit when an astral pair straddles it', async () => {
    // The first 160 UTF-16 units end inside the emoji's surrogate pair.
    const goal = `${'a'.repeat(PLAN_NODE_GOAL_HEAD_MAX_CHARS - 1)}😀${'b'.repeat(40)}`;
    await node('astral', { goal });

    const [tree] = (await read()).roots;

    expect(tree?.goalHead).toBe('a'.repeat(PLAN_NODE_GOAL_HEAD_MAX_CHARS - 1));
    // What Postgres's left(goal, 160) hands back — 160 code points, 161 units — is cut the same way.
    const left = [...goal].slice(0, PLAN_NODE_GOAL_HEAD_MAX_CHARS).join('');
    expect(left.length).toBeGreaterThan(PLAN_NODE_GOAL_HEAD_MAX_CHARS);
    expect(planGoalHead(left)).toBe('a'.repeat(PLAN_NODE_GOAL_HEAD_MAX_CHARS - 1));
    const emojis = '😀'.repeat(PLAN_NODE_GOAL_HEAD_MAX_CHARS);
    expect(planGoalHead(emojis)).toBe('😀'.repeat(PLAN_NODE_GOAL_HEAD_MAX_CHARS / 2));
  });

  it('counts each node’s links by kind, its runs in flight, and its review rounds among its run links', async () => {
    const root = await node('root');
    const step = await node('step', { parentId: root.nodeId });
    const run = (n: number, label: string) =>
      linkPlanNode(ctx(), {
        nodeId: step.nodeId,
        kind: 'run',
        ref: `00000000-0000-4000-8000-0000000000c${String(n)}`,
        label,
      });
    await run(1, 'commission-change completed');
    await run(2, 'review-local-changes completed');
    await run(3, 'publish-local-changes failed');
    await run(4, 'review-local-changes failed');
    await run(5, 'review-pull-request completed');
    for (const [kind, ref] of [
      ['finding', 'F1'],
      ['finding', 'F2'],
      ['document', '/notes/design.md'],
      ['pull_request', PR],
    ] as const) {
      await linkPlanNode(ctx(), { nodeId: step.nodeId, kind, ref });
    }
    store.runs.push(
      inFlightRun('r-running', step.nodeId, 'running'),
      inFlightRun('r-ended', step.nodeId, 'completed'),
    );

    const roots = (await read()).roots;

    expect(find(roots, step.nodeId)?.counts).toEqual({
      runs: 5,
      pullRequests: 1,
      findings: 2,
      documents: 1,
      inFlightRuns: 1,
    });
    expect(find(roots, step.nodeId)?.rounds).toBe(3);
    expect(find(roots, root.nodeId)?.counts).toEqual({
      runs: 0,
      pullRequests: 0,
      findings: 0,
      documents: 0,
      inFlightRuns: 0,
    });
    expect(find(roots, root.nodeId)?.rounds).toBe(0);
  });

  it('reads a node in flight only while a run in flight serves it, and idle otherwise', async () => {
    const root = await node('root');
    const bare = await node('bare', { parentId: root.nodeId });
    const served = await node('served', { parentId: root.nodeId });
    const running = await node('in flight', { parentId: root.nodeId });
    const waiting = store.seed(SPACE, {
      parentId: root.nodeId,
      title: 'waiting',
      status: 'waiting',
    });
    await linkPlanNode(ctx(), {
      nodeId: served.nodeId,
      kind: 'run',
      ref: '00000000-0000-4000-8000-0000000000c1',
    });
    store.runs.push(inFlightRun('r1', running.nodeId, 'paused'));

    const roots = (await read()).roots;

    expect(find(roots, bare.nodeId)?.activity).toBe('idle');
    expect(find(roots, served.nodeId)?.activity).toBe('idle');
    expect(find(roots, running.nodeId)?.activity).toBe('in_flight');
    expect(find(roots, waiting.nodeId)?.activity).toBe('idle');
  });

  it('reads a parent with no run of its own in flight where a run serves an active node under it, through every level', async () => {
    const root = await node('root');
    const phase = await node('P1 — phase', { parentId: root.nodeId });
    const step = await node('running step', { parentId: phase.nodeId });
    await node('bare step', { parentId: phase.nodeId });
    const idle = await node('idle phase', { parentId: root.nodeId });
    const linked = await node('served before', { parentId: idle.nodeId });
    const idleRoot = await node('idle root');
    await node('bare under idle root', { parentId: idleRoot.nodeId });
    store.runs.push(inFlightRun('r4', step.nodeId, 'running'));
    await linkPlanNode(ctx(), {
      nodeId: linked.nodeId,
      kind: 'run',
      ref: '00000000-0000-4000-8000-0000000000c2',
    });

    const roots = (await read()).roots;

    expect(find(roots, phase.nodeId)?.activity).toBe('in_flight');
    expect(find(roots, root.nodeId)?.activity).toBe('in_flight');
    expect(find(roots, idle.nodeId)?.activity).toBe('idle');
    expect(find(roots, idleRoot.nodeId)?.activity).toBe('idle');
  });

  it('reads a decide node idle like any other, its column still Needs you', async () => {
    const root = await node('root');
    const decide = await node('choose', { parentId: root.nodeId, kind: 'decide' });

    const roots = (await read()).roots;

    expect(find(roots, decide.nodeId)?.activity).toBe('idle');
    expect(planBoardColumn(find(roots, decide.nodeId)!, { closedAncestor: false })).toEqual({
      column: 'needs_you',
      reason: 'decide',
    });
  });

  it('counts only active descendants toward a parent’s activity, through every level', async () => {
    const root = await node('root');
    const settled = await node('settled phase', { parentId: root.nodeId });
    const done = await node('done step', { parentId: settled.nodeId });
    await linkPlanNode(ctx(), {
      nodeId: done.nodeId,
      kind: 'run',
      ref: '00000000-0000-4000-8000-0000000000c3',
    });
    await close(done, 'done');
    await close(await node('dropped step', { parentId: settled.nodeId }), 'dropped');
    store.seed(SPACE, { parentId: settled.nodeId, title: 'blocked step', status: 'blocked' });
    store.seed(SPACE, { parentId: settled.nodeId, title: 'waiting step', status: 'waiting' });
    const moving = await node('moving phase', { parentId: root.nodeId });
    const active = await node('active step', { parentId: moving.nodeId });
    store.seed(SPACE, { parentId: moving.nodeId, title: 'waiting beside', status: 'waiting' });
    store.runs.push(inFlightRun('r3', active.nodeId, 'running'));
    const settledRoot = await node('settled root');
    store.seed(SPACE, { parentId: settledRoot.nodeId, title: 'waiting only', status: 'waiting' });

    const roots = (await read()).roots;

    expect(find(roots, done.nodeId)?.activity).toBe('idle');
    expect(find(roots, settled.nodeId)?.activity).toBe('idle');
    expect(find(roots, settledRoot.nodeId)?.activity).toBe('idle');
    expect(find(roots, moving.nodeId)?.activity).toBe('in_flight');
    expect(find(roots, root.nodeId)?.activity).toBe('in_flight');

    store.runs.length = 0;
    const idle = (await read()).roots;
    expect(find(idle, moving.nodeId)?.activity).toBe('idle');
    expect(find(idle, root.nodeId)?.activity).toBe('idle');
  });

  it('leaves a parent idle where the only run under it serves a node no longer active', async () => {
    const root = await node('root');
    const phase = await node('phase', { parentId: root.nodeId });
    const done = await node('done step', { parentId: phase.nodeId });
    const blocked = store.seed(SPACE, {
      parentId: phase.nodeId,
      title: 'blocked step',
      status: 'blocked',
    });
    const under = await node('active under blocked', { parentId: blocked.nodeId });
    await close(done, 'done');
    store.runs.push(inFlightRun('r5', done.nodeId, 'running'));

    const roots = (await read()).roots;
    expect(find(roots, done.nodeId)?.activity).toBe('in_flight');
    expect(find(roots, phase.nodeId)?.activity).toBe('idle');
    expect(find(roots, root.nodeId)?.activity).toBe('idle');

    store.runs.push(inFlightRun('r6', under.nodeId, 'running'));
    const deeper = (await read()).roots;
    expect(find(deeper, blocked.nodeId)?.activity).toBe('in_flight');
    expect(find(deeper, phase.nodeId)?.activity).toBe('in_flight');
    expect(find(deeper, root.nodeId)?.activity).toBe('in_flight');
  });

  it('reads a parent in flight where a run serves it, whatever its children', async () => {
    const root = await node('root');
    await node('bare', { parentId: root.nodeId });
    store.runs.push(inFlightRun('r2', root.nodeId, 'running'));

    expect(find((await read()).roots, root.nodeId)?.activity).toBe('in_flight');
  });

  it('builds one day formatter for every done node of a plan', async () => {
    const root = await node('one');
    for (const n of [1, 2, 3])
      await close(await node(`one ${String(n)}`, { parentId: root.nodeId }), 'done');
    const built = countDayFormatters();
    try {
      const read = await board(root.nodeId, { tz: 'Europe/Paris' });

      expect(read.tally.done).toBe(3);
      expect(built.count).toBe(1);
    } finally {
      built.restore();
    }
  });

  it('surfaces the newest pull request, merged where a merge of it is linked, with the merge commit', async () => {
    const root = await node('root');
    const merged = await node('merged', { parentId: root.nodeId });
    const open = await node('open', { parentId: root.nodeId });
    await linkPlanNode(ctx(), { nodeId: merged.nodeId, kind: 'pull_request', ref: OLDER_PR });
    await linkPlanNode(ctx(), { nodeId: merged.nodeId, kind: 'pull_request', ref: PR });
    await linkPlanNode(ctx(), {
      nodeId: merged.nodeId,
      kind: 'merge',
      ref: PR,
      label: mergeLinkLabel('2026-10-05T10:00:00.000Z', 'abc1234def'),
    });
    await linkPlanNode(ctx(), { nodeId: open.nodeId, kind: 'pull_request', ref: PR });
    await linkPlanNode(ctx(), {
      nodeId: open.nodeId,
      kind: 'merge',
      ref: OLDER_PR,
      label: mergeLinkLabel('2026-10-04T10:00:00.000Z'),
    });

    const roots = (await read()).roots;

    expect(find(roots, merged.nodeId)?.pullRequest).toEqual({
      url: PR,
      merged: true,
      mergeSha: 'abc1234def',
    });
    // A merge of another pull request says nothing of this one.
    expect(find(roots, open.nodeId)?.pullRequest).toEqual({ url: PR, merged: false });
    expect(find(roots, root.nodeId)).not.toHaveProperty('pullRequest');
  });

  it('gives a parent its progress from its children — done, of those not dropped — and a leaf none', async () => {
    const root = await node('root');
    const phase = await node('phase', { parentId: root.nodeId });
    const a = await node('a', { parentId: phase.nodeId });
    await close(a, 'done');
    await close(await node('b', { parentId: phase.nodeId }), 'done');
    await close(await node('c', { parentId: phase.nodeId }), 'dropped');
    const open = await node('d', { parentId: phase.nodeId });
    await node('under d', { parentId: open.nodeId });

    const roots = (await read()).roots;

    expect(find(roots, phase.nodeId)?.progress).toEqual({ done: 2, total: 3 });
    expect(find(roots, open.nodeId)?.progress).toEqual({ done: 0, total: 1 });
    expect(find(roots, root.nodeId)?.progress).toEqual({ done: 0, total: 1 });
    expect(find(roots, a.nodeId)).not.toHaveProperty('progress');
  });

  it('tallies each plan over every node under its root, by the board’s columns', async () => {
    const root = await node('Plan 315');
    const phase = await node('P3', { parentId: root.nodeId });
    await node('building', { parentId: phase.nodeId });
    await node('choose', { parentId: phase.nodeId, kind: 'decide' });
    store.seed(SPACE, { parentId: phase.nodeId, title: 'on a person', status: 'blocked' });
    store.seed(SPACE, { parentId: phase.nodeId, title: 'queued', status: 'waiting' });
    await close(await node('landed', { parentId: phase.nodeId }), 'done');
    await close(await node('let go', { parentId: root.nodeId }), 'dropped');
    const other = await node('Plan 322', { position: 9 });

    const { tallies } = await read();

    // P3 and building are up next, queued in flight; choose and on a person need the operator.
    expect(tallies[0]).toMatchObject({
      rootId: root.nodeId,
      state: 'needs_you',
      steps: 7,
      needsYou: 2,
      inFlight: 1,
      upNext: 2,
      done: 1,
      dropped: 1,
    });
    expect(tallies[1]).toEqual({
      rootId: other.nodeId,
      state: 'empty',
      steps: 0,
      needsYou: 0,
      inFlight: 0,
      upNext: 0,
      done: 0,
      dropped: 0,
      doneByDay: [],
    });
  });

  it('tallies a step running and an open step under a closed one by where they stand', async () => {
    const root = await node('Plan 320');
    const p6 = await node('P6', { parentId: root.nodeId });
    const under = await node('P6.a', { parentId: p6.nodeId });
    store.seed(SPACE, { parentId: under.nodeId, title: 'P6.a.1', status: 'blocked' });
    const running = await node('running', { parentId: root.nodeId, position: 5 });
    store.runs.push(inFlightRun('r7', running.nodeId, 'running'));
    await close(p6, 'done');

    const { tallies } = await read();

    expect(tallies[0]).toMatchObject({ steps: 4, needsYou: 2, inFlight: 1, upNext: 0, done: 1 });
  });

  it('marks Next on the step the stream walk takes, and lists Up next in the walk’s order', async () => {
    const root = await node('Plan 315', { position: 0 });
    const p1 = await node('P1', { parentId: root.nodeId, position: 0 });
    await close(await node('P1.1', { parentId: p1.nodeId, position: 0 }), 'done');
    const p1b = await node('P1.2', { parentId: p1.nodeId, position: 1 });
    await node('P1.2.a', { parentId: p1b.nodeId, position: 1 });
    const first = await node('P1.2.b', { parentId: p1b.nodeId, position: 0 });
    await node('P1.3', { parentId: p1.nodeId, position: 2 });
    const p2 = await node('P2', { parentId: root.nodeId, position: 1 });
    await node('P2.1', { parentId: p2.nodeId });
    store.seed(SPACE, { parentId: p2.nodeId, title: 'P2.2', status: 'blocked', position: 1 });
    const running = await node('P2.3', { parentId: p2.nodeId, position: 2 });
    store.runs.push(inFlightRun('r8', running.nodeId, 'running'));
    const blockedRoot = await node('Plan 331', { position: 1 });
    const stop = store.seed(SPACE, {
      parentId: blockedRoot.nodeId,
      title: 'the stop',
      status: 'blocked',
    });
    await node('after the stop', { parentId: blockedRoot.nodeId, position: 3 });
    const bareRoot = await node('Plan 329', { position: 2 });

    const board = await read();
    const walked = await store.walk(SPACE, PLAN_TREE_WALK_BOUNDS);
    const walkOrder = orderPlanTree(walked.nodes).map((p) => p.node.nodeId);

    for (const tree of board.roots) {
      const tally = board.tallies.find((t) => t.rootId === tree.nodeId);
      const taken = findActiveStreamNode(walked.nodes, tree.nodeId);
      const expected = taken !== null && taken.nodeId !== tree.nodeId ? taken.nodeId : undefined;
      expect(tally?.nextNodeId).toBe(expected);
      const upNext = planBoardCards(tree)
        .filter((card) => card.column === 'up_next')
        .map((card) => card.node.nodeId);
      expect(upNext).toEqual(walkOrder.filter((id) => upNext.includes(id)));
    }
    const tallyOf = (rootId: string) => board.tallies.find((t) => t.rootId === rootId);
    expect(tallyOf(root.nodeId)?.nextNodeId).toBe(first.nodeId);
    expect(
      planBoardCards(board.roots[0]!)
        .filter((card) => card.column === 'up_next')
        .map((card) => card.node.title),
    ).toEqual(['P1', 'P1.2', 'P1.2.b', 'P1.2.a', 'P1.3', 'P2.1']);
    expect(tallyOf(blockedRoot.nodeId)?.nextNodeId).toBe(stop.nodeId);
    expect(tallyOf(bareRoot.nodeId)).not.toHaveProperty('nextNodeId');
  });

  it('carries the note’s first line on each node, cut as the goal’s head is', async () => {
    const root = await node('root', {
      note: `  ${'n'.repeat(PLAN_NODE_NOTE_HEAD_MAX_CHARS + 20)}\nThe rest of the note.`,
    });
    const step = await node('step', {
      parentId: root.nodeId,
      note: 'Proposed: wire the board.\nMore.',
    });
    const bare = await node('bare', { parentId: root.nodeId });

    const roots = (await read()).roots;

    expect(find(roots, root.nodeId)?.noteHead).toBe('n'.repeat(PLAN_NODE_NOTE_HEAD_MAX_CHARS));
    expect(find(roots, step.nodeId)?.noteHead).toBe('Proposed: wire the board.');
    expect(find(roots, bare.nodeId)).not.toHaveProperty('noteHead');
  });

  it('counts done nodes by the day they closed in the reader’s time zone, newest first', async () => {
    const root = store.seed(SPACE, { title: 'Plan 315' });
    const done = (title: string, closedAt: string) =>
      store.seed(SPACE, { parentId: root.nodeId, title, status: 'done', closedAt });
    done('a', '2026-10-22T09:00:00.000Z');
    done('b', '2026-10-22T23:30:00.000Z');
    done('c', '2026-10-21T12:00:00.000Z');
    const phase = done('d', '2026-10-05T12:00:00.000Z');
    store.seed(SPACE, {
      parentId: phase.nodeId,
      title: 'under d',
      status: 'done',
      closedAt: '2026-10-05T11:00:00.000Z',
    });
    store.seed(SPACE, {
      parentId: root.nodeId,
      title: 'dropped',
      status: 'dropped',
      closedAt: '2026-10-22T10:00:00.000Z',
    });

    expect((await read()).tallies[0]?.doneByDay).toEqual([
      { day: '2026-10-22', count: 2 },
      { day: '2026-10-21', count: 1 },
      { day: '2026-10-05', count: 2 },
    ]);
    // 23:30 UTC is the next morning in Paris.
    expect((await read({ tz: 'Europe/Paris' })).tallies[0]?.doneByDay).toEqual([
      { day: '2026-10-23', count: 1 },
      { day: '2026-10-22', count: 1 },
      { day: '2026-10-21', count: 1 },
      { day: '2026-10-05', count: 2 },
    ]);
  });

  it('leaves out done nodes closed before closedSince, keeping the roots, a parent over a node kept, and the tallies whole', async () => {
    const root = store.seed(SPACE, {
      title: 'Plan 315',
      status: 'done',
      closedAt: '2026-09-01T00:00:00.000Z',
    });
    let position = 0;
    const at = (title: string, extra: Partial<PlanNode>) =>
      store.seed(SPACE, { parentId: root.nodeId, title, position: position++, ...extra });
    at('recent', { status: 'done', closedAt: '2026-10-22T09:00:00.000Z' });
    at('old', { status: 'done', closedAt: '2026-10-05T09:00:00.000Z' });
    at('dropped long ago', { status: 'dropped', closedAt: '2026-10-01T09:00:00.000Z' });
    const oldParent = at('old parent', { status: 'done', closedAt: '2026-10-02T09:00:00.000Z' });
    store.seed(SPACE, { parentId: oldParent.nodeId, title: 'still open' });
    const oldPhase = at('old phase', { status: 'done', closedAt: '2026-10-02T09:00:00.000Z' });
    store.seed(SPACE, {
      parentId: oldPhase.nodeId,
      title: 'old under old',
      status: 'done',
      closedAt: '2026-10-02T09:00:00.000Z',
    });

    const all = await read();
    const windowed = await read({ closedSince: '2026-10-22T00:00:00.000Z' });

    expect(titles(windowed.roots)).toEqual([
      { 'Plan 315': ['recent', 'dropped long ago', { 'old parent': ['still open'] }] },
    ]);
    expect(windowed.tallies).toEqual(all.tallies);
    expect(windowed.tallies[0]?.done).toBe(5);
    // A card's progress is its parent's whole, not what the window kept.
    expect(find(windowed.roots, root.nodeId)?.progress).toEqual(
      find(all.roots, root.nodeId)?.progress,
    );
  });

  it(`reads short past depth ${String(PLAN_TREE_DEPTH_LIMIT)} and names the bound`, async () => {
    let parent = store.seed(SPACE, { title: 'level 0' });
    for (let depth = 1; depth <= PLAN_TREE_DEPTH_LIMIT + 1; depth++) {
      parent = store.seed(SPACE, { parentId: parent.nodeId, title: `level ${String(depth)}` });
    }

    const trees = await read();

    expect(trees.truncated).toEqual({ bound: 'depth', value: PLAN_TREE_DEPTH_LIMIT });
    let depth = 0;
    for (let at = trees.roots[0]; at?.children[0] !== undefined; at = at.children[0]) depth++;
    expect(depth).toBe(PLAN_TREE_DEPTH_LIMIT);
  });
});

describe('readPlanBoard — scoped to one root', () => {
  it('returns no other root’s nodes, and only that root’s tally', async () => {
    const mine = await node('Plan 332', { position: 0 });
    const step = await node('P3', { parentId: mine.nodeId });
    await node('P3.1', { parentId: step.nodeId });
    const other = await node('Plan 331', { position: 1 });
    const otherStep = await node('P1', { parentId: other.nodeId });
    store.runs.push(inFlightRun('r-other', otherStep.nodeId, 'running'));

    const read = await board(mine.nodeId);

    expect(titles([read.root])).toEqual([{ 'Plan 332': [{ P3: ['P3.1'] }] }]);
    const ids = JSON.stringify(read);
    expect(ids).not.toContain(other.nodeId);
    expect(ids).not.toContain(otherStep.nodeId);
    expect(read.tally).toMatchObject({ rootId: mine.nodeId, steps: 2, inFlight: 0, upNext: 2 });
  });

  it('finds no plan for a step’s id, a root of another space, or an id the space never held', async () => {
    const root = await node('Plan 332');
    const step = await node('P3', { parentId: root.nodeId });
    const foreign = await node('elsewhere', {}, OTHER_SPACE);

    for (const id of [step.nodeId, foreign.nodeId, '00000000-0000-4000-8000-0000000000ee']) {
      const result = await readPlanBoard({ store, spaceId: SPACE }, id);
      expect(result).toMatchObject({ ok: false, code: 'PLAN_NODE_NOT_FOUND' });
    }
  });
});

describe('planRootState — a plan’s state (Plan 332 D3)', () => {
  const none = { steps: 0, needsYou: 0, inFlight: 0, upNext: 0 };

  it('reads each state by its rule, the first that holds deciding', () => {
    expect(planRootState('done', { ...none, steps: 3, needsYou: 1 })).toBe('closed');
    expect(planRootState('dropped', none)).toBe('closed');
    expect(planRootState('active', { ...none, steps: 2, needsYou: 1, upNext: 1 })).toBe(
      'needs_you',
    );
    expect(planRootState('active', { ...none, steps: 2, inFlight: 1, upNext: 1 })).toBe(
      'in_flight',
    );
    expect(planRootState('active', { ...none, steps: 2, upNext: 1 })).toBe('queued');
    expect(planRootState('active', { ...none, steps: 2 })).toBe('finished');
    expect(planRootState('active', none)).toBe('empty');
  });

  it('reads a plan both needing the operator and in flight as needs_you', () => {
    expect(planRootState('active', { steps: 2, needsYou: 1, inFlight: 1, upNext: 0 })).toBe(
      'needs_you',
    );
  });

  it('reads a blocked or waiting root by its steps, not by its own status', () => {
    expect(planRootState('blocked', { ...none, steps: 1, upNext: 1 })).toBe('queued');
    expect(planRootState('waiting', { ...none, steps: 1 })).toBe('finished');
  });
});

describe('readPlanOverview — the plans as rows', () => {
  it('reads an empty space as no rows', async () => {
    expect(await rows()).toEqual({ roots: [] });
  });

  it('derives every state on the server from the plan’s own steps', async () => {
    const closed = await node('closed', { position: 0 });
    await node('open under closed', { parentId: closed.nodeId });
    await close(closed, 'done');

    const needsYou = await node('needs you and in flight', { position: 1 });
    store.seed(SPACE, { parentId: needsYou.nodeId, title: 'a stop', status: 'blocked' });
    const running = await node('running', { parentId: needsYou.nodeId, position: 1 });
    store.runs.push(inFlightRun('r1', running.nodeId, 'running'));

    const inFlight = await node('in flight', { position: 2 });
    store.seed(SPACE, { parentId: inFlight.nodeId, title: 'on a run', status: 'waiting' });
    await node('after it', { parentId: inFlight.nodeId, position: 1 });

    const queued = await node('queued', { position: 3 });
    await node('approved', { parentId: queued.nodeId });
    await close(await node('landed', { parentId: queued.nodeId, position: 1 }), 'done');

    const finished = await node('finished', { position: 4 });
    await close(await node('landed', { parentId: finished.nodeId }), 'done');
    await close(await node('let go', { parentId: finished.nodeId, position: 1 }), 'dropped');

    await node('empty', { position: 5 });

    const read = await rows();

    expect(read.roots.map((r) => [r.title, r.state])).toEqual([
      ['closed', 'closed'],
      ['needs you and in flight', 'needs_you'],
      ['in flight', 'in_flight'],
      ['queued', 'queued'],
      ['finished', 'finished'],
      ['empty', 'empty'],
    ]);
    // Both counts on the row of a plan that needs the operator while a run is on it.
    expect(read.roots[1]?.counts).toEqual({
      steps: 2,
      needsYou: 1,
      inFlight: 1,
      upNext: 0,
      done: 0,
      dropped: 0,
    });
    // Finished is not a status: the root stays open until the operator closes it.
    expect(read.roots[4]).toMatchObject({
      status: 'active',
      counts: { steps: 2, done: 1, dropped: 1 },
    });
    // A closed plan is closed by rule: its steps are not read, so it has no counts.
    expect(read.roots[0]).not.toHaveProperty('counts');
  });

  it('reads a closed plan’s root alone, whatever the space has held', async () => {
    const closedSteps: string[] = [];
    for (let n = 0; n < 30; n++) {
      const root = await node(`closed ${String(n)}`, { position: n + 3 });
      for (const m of [1, 2])
        closedSteps.push((await node(`step ${String(m)}`, { parentId: root.nodeId })).nodeId);
      await close(root, 'done');
    }
    const open = await node('open', { position: 0 });
    const step = await node('open step', { parentId: open.nodeId });
    const walks = vi.spyOn(store, 'walk');
    const runLookups = vi.spyOn(store, 'inFlightRunCountsOf');

    const read = await rows();

    expect(read.roots).toHaveLength(31);
    expect(read.roots[0]).toMatchObject({ nodeId: open.nodeId, state: 'queued' });
    expect(read.roots.slice(1).every((r) => r.state === 'closed' && r.counts === undefined)).toBe(
      true,
    );
    expect(walks).toHaveBeenCalledTimes(2);
    expect(runLookups).toHaveBeenCalledTimes(1);
    const looked = runLookups.mock.calls[0]![1];
    expect([...looked].sort()).toEqual([open.nodeId, step.nodeId].sort());
    expect(looked.some((id) => closedSteps.includes(id))).toBe(false);
  });

  it('lists every root by position, open and closed, with its revision and its newest write', async () => {
    const later = store.seed(SPACE, {
      title: 'second',
      position: 5,
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    const first = store.seed(SPACE, {
      title: 'first',
      position: 1,
      revision: 4,
      updatedAt: '2026-10-02T00:00:00.000Z',
    });
    store.seed(SPACE, {
      parentId: later.nodeId,
      title: 'written last',
      updatedAt: '2026-10-20T00:00:00.000Z',
    });
    store.seed(SPACE, {
      title: 'gone',
      position: 3,
      status: 'dropped',
      closedAt: '2026-10-03T00:00:00.000Z',
    });
    await node('elsewhere', {}, OTHER_SPACE);

    const read = await rows();

    expect(read.roots.map((r) => [r.title, r.position, r.status])).toEqual([
      ['first', 1, 'active'],
      ['gone', 3, 'dropped'],
      ['second', 5, 'active'],
    ]);
    expect(read.roots[0]).toMatchObject({
      nodeId: first.nodeId,
      revision: 4,
      lastWrittenAt: '2026-10-02T00:00:00.000Z',
    });
    expect(read.roots[2]?.lastWrittenAt).toBe('2026-10-20T00:00:00.000Z');
  });

  it('counts each row by the same rule as its board’s tally', async () => {
    const root = await node('Plan 320');
    const p6 = await node('P6', { parentId: root.nodeId });
    await node('P6.a', { parentId: p6.nodeId });
    const running = await node('running', { parentId: root.nodeId, position: 5 });
    store.runs.push(inFlightRun('r7', running.nodeId, 'running'));
    await close(p6, 'done');

    const [row] = (await rows()).roots;
    const { tally } = await board(root.nodeId);

    expect(row?.state).toBe(tally.state);
    expect(row?.counts).toEqual({
      steps: tally.steps,
      needsYou: tally.needsYou,
      inFlight: tally.inFlight,
      upNext: tally.upNext,
      done: tally.done,
      dropped: tally.dropped,
    });
  });

  it('marks the plans the shared walk cut short, and counts every plan it read whole as its board does', async () => {
    const closedAt = '2026-10-03T00:00:00.000Z';
    const wide = store.seed(SPACE, { title: 'wide', position: 0 });
    for (let n = 0; n < PLAN_TREE_WALK_NODE_LIMIT - 10; n++) {
      store.seed(SPACE, { parentId: wide.nodeId, title: `wide ${String(n)}`, position: n });
    }
    const flat = store.seed(SPACE, { title: 'flat', position: 1 });
    store.seed(SPACE, { parentId: flat.nodeId, title: 'landed', status: 'done', closedAt });
    store.seed(SPACE, { parentId: flat.nodeId, title: 'approved', position: 1 });
    const deep = store.seed(SPACE, { title: 'deep', position: 2 });
    const a = store.seed(SPACE, { parentId: deep.nodeId, title: 'a', status: 'done', closedAt });
    const b = store.seed(SPACE, { parentId: a.nodeId, title: 'b', status: 'done', closedAt });
    // The walk's last three nodes are deep's first three leaves, all done; the
    // two open ones past them are past its bound.
    for (let n = 0; n < 5; n++) {
      store.seed(SPACE, {
        parentId: b.nodeId,
        title: `leaf ${String(n)}`,
        position: n,
        ...(n < 3 ? { status: 'done' as const, closedAt } : {}),
      });
    }
    // A closed plan takes nothing from the bound.
    const gone = store.seed(SPACE, { title: 'gone', position: 3, status: 'dropped', closedAt });
    store.seed(SPACE, { parentId: gone.nodeId, title: 'under gone' });

    const read = await rows();
    const rowOf = (id: string) => read.roots.find((r) => r.nodeId === id)!;

    expect(read.truncated).toBeUndefined();
    expect(rowOf(deep.nodeId)).toMatchObject({
      truncated: { bound: 'nodes', value: PLAN_TREE_WALK_NODE_LIMIT },
      counts: { steps: 5, done: 5 },
    });
    expect((await board(deep.nodeId)).tally).toMatchObject({ steps: 7, done: 5, needsYou: 2 });
    for (const id of [wide.nodeId, flat.nodeId]) {
      const row = rowOf(id);
      const { tally, truncated } = await board(id);
      expect(row).not.toHaveProperty('truncated');
      expect(truncated).toBeUndefined();
      expect(row.state).toBe(tally.state);
      expect(row.counts).toEqual({
        steps: tally.steps,
        needsYou: tally.needsYou,
        inFlight: tally.inFlight,
        upNext: tally.upNext,
        done: tally.done,
        dropped: tally.dropped,
      });
    }
    expect(rowOf(flat.nodeId)).toMatchObject({ state: 'queued', counts: { steps: 2, done: 1 } });
    expect(rowOf(gone.nodeId)).toMatchObject({ state: 'closed' });
  });

  it(`counts short past depth ${String(PLAN_TREE_DEPTH_LIMIT)} and names the bound on that plan’s row`, async () => {
    let parent = store.seed(SPACE, { title: 'level 0' });
    for (let depth = 1; depth <= PLAN_TREE_DEPTH_LIMIT + 1; depth++) {
      parent = store.seed(SPACE, { parentId: parent.nodeId, title: `level ${String(depth)}` });
    }
    const shallow = store.seed(SPACE, { title: 'shallow', position: 1 });
    store.seed(SPACE, { parentId: shallow.nodeId, title: 'one step' });

    const read = await rows();

    expect(read.truncated).toBeUndefined();
    expect(read.roots[0]).toMatchObject({
      truncated: { bound: 'depth', value: PLAN_TREE_DEPTH_LIMIT },
      counts: { steps: PLAN_TREE_DEPTH_LIMIT },
    });
    expect(read.roots[1]).not.toHaveProperty('truncated');
  });

  it('lists every plan when the open roots exactly fill the node bound, their steps counted short', async () => {
    for (let n = 0; n < PLAN_TREE_WALK_NODE_LIMIT; n++) {
      const root = store.seed(SPACE, { title: `plan ${String(n)}`, position: n });
      store.seed(SPACE, { parentId: root.nodeId, title: 'a step' });
    }

    const read = await rows();

    expect(read.truncated).toBeUndefined();
    expect(read.roots).toHaveLength(PLAN_TREE_WALK_NODE_LIMIT);
    expect(read.roots[0]).toMatchObject({
      truncated: { bound: 'nodes', value: PLAN_TREE_WALK_NODE_LIMIT },
    });
  });

  it('says the list of plans was cut when more open roots than the node bound holds', async () => {
    for (let n = 0; n <= PLAN_TREE_WALK_NODE_LIMIT; n++) {
      store.seed(SPACE, { title: `plan ${String(n)}`, position: n });
    }

    const read = await rows();

    expect(read.truncated).toEqual({ bound: 'nodes', value: PLAN_TREE_WALK_NODE_LIMIT });
    expect(read.roots).toHaveLength(PLAN_TREE_WALK_NODE_LIMIT);
  });
});

describe('buildPlanBoard — a node written between the walk and its row', () => {
  const summary: PlanNodeSummary = {
    nodeId: '0d000000-0000-4000-8000-000000000322',
    parentId: null,
    kind: 'execute',
    title: 'reopened',
    status: 'done',
    revision: 2,
    position: 0,
    createdAt: '2026-10-20T09:00:00.000Z',
    updatedAt: '2026-10-21T09:00:00.000Z',
    closedAt: '2026-10-21T09:00:00.000Z',
  };
  const board = (facts: Map<string, { createdAt: string; closedAt?: string; goalHead: string }>) =>
    buildPlanBoard([{ node: summary, depth: 0 }], {
      facts,
      tallies: new Map(),
      pullRequests: new Map(),
      inFlight: new Map(),
    }).roots[0];

  it('drops the closedAt the walk read once the row says the node is open again', () => {
    const card = board(
      new Map([[summary.nodeId, { createdAt: summary.createdAt, goalHead: 'Ship it.' }]]),
    );

    expect(card).not.toHaveProperty('closedAt');
    expect(card?.createdAt).toBe(summary.createdAt);
  });

  it('takes the row’s closedAt over the walk’s', () => {
    const closedAt = '2026-10-22T09:00:00.000Z';
    const card = board(
      new Map([[summary.nodeId, { createdAt: summary.createdAt, closedAt, goalHead: '' }]]),
    );

    expect(card?.closedAt).toBe(closedAt);
  });

  it('keeps the summary’s own createdAt and closedAt for a node whose row is gone', () => {
    const card = board(new Map());

    expect(card?.createdAt).toBe(summary.createdAt);
    expect(card?.closedAt).toBe(summary.closedAt);
  });
});

describe('planDayReader', () => {
  it('names the calendar day an instant falls on in a time zone', () => {
    expect(planDayReader()('2026-10-22T23:30:00.000Z')).toBe('2026-10-22');
    expect(planDayReader('Europe/Paris')('2026-10-22T23:30:00.000Z')).toBe('2026-10-23');
    expect(planDayReader('America/Los_Angeles')('2026-10-22T03:00:00.000Z')).toBe('2026-10-21');
  });

  it('builds its formatter once and reads every instant with it', () => {
    const built = countDayFormatters();
    try {
      const dayOf = planDayReader('Europe/Paris');
      const days = ['2026-10-20T10:00:00.000Z', '2026-10-21T23:30:00.000Z'].map(dayOf);

      expect(days).toEqual(['2026-10-20', '2026-10-22']);
      expect(built.count).toBe(1);
    } finally {
      built.restore();
    }
  });
});

describe('readPlanNodeDetail — the rail', () => {
  async function detail(nodeId: string, query: Record<string, unknown> = {}) {
    const result = await readPlanNodeDetail(
      { store, spaceId: SPACE },
      nodeId,
      PlanNodeDetailQuerySchema.parse(query),
    );
    if (!result.ok) throw new Error(result.message);
    const { ok: _ok, ...read } = result;
    return PlanNodeDetailOutputSchema.parse(read);
  }

  it('reads the node in full with its children and the runs in flight under it', async () => {
    const root = await node('root');
    const child = await node('child', { parentId: root.nodeId });
    store.runs.push(inFlightRun('r1', child.nodeId, 'running'));

    const read = await detail(root.nodeId);

    expect(read.node).toMatchObject({ nodeId: root.nodeId, goal: 'Goal of root.' });
    expect(read.children.map((c) => c.nodeId)).toEqual([child.nodeId]);
    expect(read.runs.map((r) => r.runId)).toEqual(['r1']);
    expect(read).toMatchObject({ links: [], linksTotal: 0 });
    expect(read).not.toHaveProperty('nextCursor');
  });

  it('pages the links newest first, 50 by default, each page after the cursor of the one before', async () => {
    const step = await node('step');
    for (let i = 0; i < 120; i++) {
      await linkPlanNode(ctx(), { nodeId: step.nodeId, kind: 'finding', ref: `F${String(i)}` });
    }

    const first = await detail(step.nodeId);
    expect(first.links).toHaveLength(50);
    expect(first.linksTotal).toBe(120);
    expect(first.links[0]?.ref).toBe('F119');
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await detail(step.nodeId, { cursor: first.nextCursor });
    const third = await detail(step.nodeId, { cursor: second.nextCursor });
    expect(second.links[0]?.ref).toBe('F69');
    expect(third.links).toHaveLength(20);
    expect(third).not.toHaveProperty('nextCursor');
    const refs = [...first.links, ...second.links, ...third.links].map((l) => l.ref);
    expect(new Set(refs).size).toBe(120);
  });

  it('reads only the kind asked for, with that kind’s total, at the limit asked for', async () => {
    const step = await node('step');
    for (let i = 0; i < 4; i++) {
      await linkPlanNode(ctx(), {
        nodeId: step.nodeId,
        kind: 'run',
        ref: `00000000-0000-4000-8000-00000000000${String(i)}`,
        label: 'commission-change completed',
      });
      await linkPlanNode(ctx(), { nodeId: step.nodeId, kind: 'finding', ref: `F${String(i)}` });
    }

    const runs = await detail(step.nodeId, { linkKind: 'run', limit: '3' });

    expect(runs.links.map((l) => l.kind)).toEqual(['run', 'run', 'run']);
    expect(runs.linksTotal).toBe(4);
    const rest = await detail(step.nodeId, {
      linkKind: 'run',
      limit: '3',
      cursor: runs.nextCursor,
    });
    expect(rest.links).toHaveLength(1);
    expect(rest).not.toHaveProperty('nextCursor');
  });

  it('pages links that share a time by kind, then ref, losing none', async () => {
    const step = await node('step');
    const createdAt = '2026-10-05T08:00:00.000Z';
    for (const ref of ['b', 'a', 'c']) {
      store.links.push({ nodeId: step.nodeId, kind: 'finding', ref, createdAt });
    }
    store.links.push({ nodeId: step.nodeId, kind: 'document', ref: '/z', createdAt });

    const first = await detail(step.nodeId, { limit: '2' });
    const second = await detail(step.nodeId, { limit: '2', cursor: first.nextCursor });

    expect([...first.links, ...second.links].map((l) => `${l.kind}:${l.ref}`)).toEqual([
      'document:/z',
      'finding:a',
      'finding:b',
      'finding:c',
    ]);
    expect(second).not.toHaveProperty('nextCursor');
  });

  it('refuses a cursor it did not issue, and a node not in the space', async () => {
    const step = await node('step');

    const forged = await readPlanNodeDetail({ store, spaceId: SPACE }, step.nodeId, {
      cursor: 'not-a-cursor',
      limit: 50,
    });
    expect(forged).toMatchObject({ ok: false, code: 'PLAN_LINK_CURSOR_INVALID' });

    const elsewhere = await node('elsewhere', {}, OTHER_SPACE);
    const missing = await readPlanNodeDetail({ store, spaceId: SPACE }, elsewhere.nodeId, {
      limit: 50,
    });
    expect(missing).toMatchObject({ ok: false, code: 'PLAN_NODE_NOT_FOUND' });
  });
});

describe('the link cursor', () => {
  it('round-trips a key at the database’s precision, and refuses anything else', () => {
    const key = { at: '2026-10-05 08:00:00.123456+00', kind: 'run' as const, ref: 'x y' };

    expect(decodePlanLinkCursor(encodePlanLinkCursor(key))).toEqual(key);
    expect(decodePlanLinkCursor('garbage')).toBeNull();
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    expect(decodePlanLinkCursor(encoded(['yesterday', 'run', 'x']))).toBeNull();
    expect(decodePlanLinkCursor(encoded(['2026-10-05T08:00:00.000Z', 'nope', 'x']))).toBeNull();
    expect(decodePlanLinkCursor(encoded({ at: '2026-10-05T08:00:00.000Z' }))).toBeNull();
  });
});
