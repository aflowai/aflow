/**
 * The space's plan as the operator's board reads it (Plan 322 P3.3): every
 * tree, every status, each node nested under its parent in sibling order with
 * its card's facts — counts in place of links, rounds, owner, newest pull
 * request, a parent's progress — each plan's tallies and done nodes by day,
 * and a done window applied on the server. And one node for the rail, its
 * links paged by an opaque cursor.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  PLAN_NODE_GOAL_HEAD_MAX_CHARS,
  PLAN_TREE_DEPTH_LIMIT,
  PlanNodeDetailOutputSchema,
  PlanNodeDetailQuerySchema,
  PlanTreeOutputSchema,
  type PlanNode,
  type PlanNodeCreateInput,
  type PlanTreeNode,
} from '@aflow/schemas';
import {
  createPlanNode,
  linkPlanNode,
  readPlanNodeDetail,
  readPlanTrees,
  updatePlanNode,
  type PlanWriteContext,
} from '../plan/operations.js';
import {
  decodePlanLinkCursor,
  encodePlanLinkCursor,
  planDayReader,
  type PlanBoardOptions,
} from '../plan/board.js';
import { planGoalHead } from '../plan/store.js';
import { mergeLinkLabel } from '../plan/stream.js';
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

async function read(opts: PlanBoardOptions = {}) {
  // What the route serializes: the engine's answer must be the schema's.
  return PlanTreeOutputSchema.parse(await readPlanTrees({ store, spaceId: SPACE }, opts));
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

describe('readPlanTrees — the board', () => {
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

  it('names an active node with no run linked or in flight the operator’s, and every other the loop’s', async () => {
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

    expect(find(roots, bare.nodeId)?.ownedBy).toBe('operator');
    expect(find(roots, served.nodeId)?.ownedBy).toBe('loop');
    expect(find(roots, running.nodeId)?.ownedBy).toBe('loop');
    expect(find(roots, waiting.nodeId)?.ownedBy).toBe('loop');
  });

  it('names a parent with no run of its own the loop’s where the loop holds any child, through every level', async () => {
    const root = await node('root');
    const phase = await node('P1 — phase', { parentId: root.nodeId });
    const step = await node('served step', { parentId: phase.nodeId });
    await node('bare step', { parentId: phase.nodeId });
    const idle = await node('idle phase', { parentId: root.nodeId });
    await node('bare under idle', { parentId: idle.nodeId });
    const idleRoot = await node('idle root');
    await node('bare under idle root', { parentId: idleRoot.nodeId });
    await linkPlanNode(ctx(), {
      nodeId: step.nodeId,
      kind: 'run',
      ref: '00000000-0000-4000-8000-0000000000c2',
    });

    const roots = (await read()).roots;

    expect(find(roots, phase.nodeId)?.ownedBy).toBe('loop');
    expect(find(roots, root.nodeId)?.ownedBy).toBe('loop');
    expect(find(roots, idle.nodeId)?.ownedBy).toBe('operator');
    expect(find(roots, idleRoot.nodeId)?.ownedBy).toBe('operator');
  });

  it('counts only active children toward a parent’s owner, through every level', async () => {
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

    expect(find(roots, done.nodeId)?.ownedBy).toBe('loop');
    expect(find(roots, settled.nodeId)?.ownedBy).toBe('operator');
    expect(find(roots, settledRoot.nodeId)?.ownedBy).toBe('operator');
    expect(find(roots, moving.nodeId)?.ownedBy).toBe('loop');
    expect(find(roots, root.nodeId)?.ownedBy).toBe('loop');

    store.runs.length = 0;
    const idle = (await read()).roots;
    expect(find(idle, moving.nodeId)?.ownedBy).toBe('operator');
    expect(find(idle, root.nodeId)?.ownedBy).toBe('operator');
  });

  it('names a parent with no run and no active child the loop holds the operator’s only while it is active', async () => {
    const root = await node('root');
    const parents = new Map<string, string>();
    for (const status of ['active', 'done', 'dropped', 'blocked', 'waiting'] as const) {
      const parent = store.seed(SPACE, { parentId: root.nodeId, title: `${status} phase`, status });
      await node(`bare under ${status}`, { parentId: parent.nodeId });
      store.seed(SPACE, {
        parentId: parent.nodeId,
        title: `waiting under ${status}`,
        status: 'waiting',
      });
      parents.set(status, parent.nodeId);
    }
    const doneRoot = store.seed(SPACE, { title: 'done root', status: 'done' });
    store.seed(SPACE, { parentId: doneRoot.nodeId, title: 'done under root', status: 'done' });

    const roots = (await read()).roots;
    const ownerOf = (status: string) => find(roots, parents.get(status)!)?.ownedBy;

    expect(ownerOf('active')).toBe('operator');
    expect(ownerOf('done')).toBe('loop');
    expect(ownerOf('dropped')).toBe('loop');
    expect(ownerOf('blocked')).toBe('loop');
    expect(ownerOf('waiting')).toBe('loop');
    expect(find(roots, doneRoot.nodeId)?.ownedBy).toBe('loop');
    expect(find(roots, root.nodeId)?.ownedBy).toBe('operator');
  });

  it('keeps a parent the loop’s where a run serves it, whatever its children', async () => {
    const root = await node('root');
    await node('bare', { parentId: root.nodeId });
    store.runs.push(inFlightRun('r2', root.nodeId, 'running'));

    expect(find((await read()).roots, root.nodeId)?.ownedBy).toBe('loop');
  });

  it('builds one day formatter for every done node of every plan', async () => {
    for (const title of ['one', 'two']) {
      const root = await node(title);
      for (const n of [1, 2, 3])
        await close(await node(`${title} ${String(n)}`, { parentId: root.nodeId }), 'done');
    }
    const built = countDayFormatters();
    try {
      const trees = await read({ tz: 'Europe/Paris' });

      expect(trees.tallies.map((t) => t.done)).toEqual([3, 3]);
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

    // P3 and building are in progress; choose and on a person need the operator.
    expect(tallies[0]).toMatchObject({
      rootId: root.nodeId,
      steps: 7,
      done: 1,
      active: 2,
      decide: 2,
      dropped: 1,
    });
    expect(tallies[1]).toEqual({
      rootId: other.nodeId,
      steps: 0,
      done: 0,
      active: 0,
      decide: 0,
      dropped: 0,
      doneByDay: [],
    });
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
