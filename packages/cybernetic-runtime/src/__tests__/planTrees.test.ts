/**
 * The space's plan as the operator reads it (Plan 322 P3): every tree, every
 * status, each node nested under its parent in sibling order, with how a
 * closed node ended, its newest links and the runs in flight serving it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  PLAN_TREE_DEPTH_LIMIT,
  PLAN_TREE_NODE_LINKS_LIMIT,
  PlanTreeOutputSchema,
  type PlanNode,
  type PlanNodeCreateInput,
  type PlanTreeNode,
} from '@aflow/schemas';
import {
  createPlanNode,
  linkPlanNode,
  readPlanTrees,
  updatePlanNode,
  type PlanWriteContext,
} from '../plan/operations.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const TENANT = 'a0000000-0000-4000-8000-000000000322';
const SPACE = '5e1d0000-0000-4000-8000-000000000322';
const OTHER_SPACE = '5e1d0000-0000-4000-8000-000000000999';
const PR = 'https://github.com/aflowai/aflow/pull/181';

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

async function read() {
  // What the route serializes: the engine's answer must be the schema's.
  return PlanTreeOutputSchema.parse(await readPlanTrees({ store, spaceId: SPACE }));
}

function titles(trees: readonly PlanTreeNode[]): unknown[] {
  return trees.map((t) => (t.children.length === 0 ? t.title : { [t.title]: titles(t.children) }));
}

beforeEach(async () => {
  store = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

describe('readPlanTrees', () => {
  it('reads an empty plan as no roots', async () => {
    expect(await read()).toEqual({ roots: [], runsTotal: 0 });
  });

  it('nests every node under its parent, roots and siblings by position, whatever their status', async () => {
    const second = await node('second root', { position: 5 });
    const first = await node('first root', { position: 1 });
    const later = await node('later', { parentId: first.nodeId, position: 2 });
    await node('earlier', { parentId: first.nodeId, position: 0 });
    await node('under later', { parentId: later.nodeId });
    const dropped = await node('dropped', { parentId: second.nodeId });
    await updatePlanNode(ctx(), {
      nodeId: dropped.nodeId,
      expectedRevision: dropped.revision,
      status: 'dropped',
      outcome: 'Superseded.',
    });
    await node('elsewhere', {}, OTHER_SPACE);

    const trees = await read();

    expect(titles(trees.roots)).toEqual([
      { 'first root': ['earlier', { later: ['under later'] }] },
      { 'second root': ['dropped'] },
    ]);
    expect(trees.roots[0]).toMatchObject({ position: 1, status: 'active', parentId: null });
    expect(trees.roots[1]?.children[0]).toMatchObject({
      status: 'dropped',
      outcome: 'Superseded.',
      parentId: second.nodeId,
    });
    expect(trees).not.toHaveProperty('truncated');
  });

  it('carries a done node’s outcome and when it closed, and nothing of the kind on an open one', async () => {
    const open = await node('open');
    const done = await node('done');
    await updatePlanNode(ctx(), {
      nodeId: done.nodeId,
      expectedRevision: done.revision,
      status: 'done',
      outcome: `Merged as ${PR}.`,
    });

    const [openTree, doneTree] = (await read()).roots;

    expect(openTree?.nodeId).toBe(open.nodeId);
    expect(openTree).not.toHaveProperty('outcome');
    expect(openTree).not.toHaveProperty('closedAt');
    expect(doneTree).toMatchObject({ status: 'done', outcome: `Merged as ${PR}.` });
    expect(doneTree?.closedAt).toEqual(expect.any(String));
  });

  it('gives each node its own links, newest first, bounded with the total', async () => {
    const root = await node('root');
    const child = await node('child', { parentId: root.nodeId });
    await linkPlanNode(ctx(), { nodeId: root.nodeId, kind: 'pull_request', ref: PR });
    for (let i = 0; i < PLAN_TREE_NODE_LINKS_LIMIT + 2; i++) {
      await linkPlanNode(ctx(), { nodeId: child.nodeId, kind: 'finding', ref: `F${String(i)}` });
    }

    const [rootTree] = (await read()).roots;
    const childTree = rootTree?.children[0];

    expect(rootTree).toMatchObject({ linksTotal: 1, links: [{ kind: 'pull_request', ref: PR }] });
    expect(childTree?.linksTotal).toBe(PLAN_TREE_NODE_LINKS_LIMIT + 2);
    expect(childTree?.links).toHaveLength(PLAN_TREE_NODE_LINKS_LIMIT);
    expect(childTree?.links[0]?.ref).toBe(`F${String(PLAN_TREE_NODE_LINKS_LIMIT + 1)}`);
  });

  it('places each run in flight under the node it serves, and leaves ended runs out', async () => {
    const root = await node('root');
    const child = await node('child', { parentId: root.nodeId });
    const run = (runId: string, nodeId: string, status: string, startedAt: string) => ({
      runId,
      slug: 'commission-change',
      status,
      nodeId,
      spaceId: SPACE,
      startedAt,
    });
    store.runs.push(
      run('run-on-root', root.nodeId, 'paused', '2026-10-05T08:00:00.000Z'),
      run('run-on-child', child.nodeId, 'running', '2026-10-05T09:00:00.000Z'),
      run('run-ended', child.nodeId, 'completed', '2026-10-05T10:00:00.000Z'),
    );

    const trees = await read();

    expect(trees.runsTotal).toBe(2);
    expect(trees.roots[0]?.runs.map((r) => r.runId)).toEqual(['run-on-root']);
    expect(trees.roots[0]?.children[0]?.runs.map((r) => [r.runId, r.status])).toEqual([
      ['run-on-child', 'running'],
    ]);
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
