/**
 * What the Action Center lists of a plan (Plan 338 D1): every open node that
 * waits on a person under open branches, read at list time with no wake and
 * no ask record, at most `PLAN_OPEN_ASKS_LIMIT` of them, newest first.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  OPEN_PLAN_NODE_STATUSES,
  PLAN_NODE_MERGE_WAIT_LINE,
  PLAN_OPEN_ASKS_LIMIT,
  StreamKeys,
  type PlanNode,
  type PlanNodeCreateInput,
} from '@aflow/schemas';
import { createPlanNode, updatePlanNode, type PlanWriteContext } from '../plan/operations.js';
import {
  askedKey,
  claimAsk,
  findWaitingNode,
  isAsked,
  isWaitingPlanNode,
  listWaitingNodes,
} from '../plan/asks.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const TENANT = 'a0000000-0000-4000-8000-000000000338';
const SPACE = '5e1d0000-0000-4000-8000-000000000338';

let store: InMemoryPlanNodeStore;
let redis: RedisType;

function ctx(): PlanWriteContext {
  return { store, redis, tenantId: TENANT, spaceId: SPACE };
}

async function node(title: string, input: Partial<PlanNodeCreateInput> = {}): Promise<PlanNode> {
  const result = await createPlanNode(ctx(), {
    kind: 'execute',
    title,
    goal: `Goal of ${title}.`,
    criteria: `Criteria of ${title}.`,
    ...input,
  });
  if (!result.ok) throw new Error(result.message);
  return result.node;
}

const blocked = (title: string, input: Partial<PlanNodeCreateInput> = {}) =>
  node(title, { proposed: 'Worth doing', ...input });

async function write(target: PlanNode, patch: Record<string, unknown>): Promise<PlanNode> {
  const now = await store.find(SPACE, target.nodeId);
  const result = await updatePlanNode(ctx(), {
    nodeId: target.nodeId,
    expectedRevision: now!.revision,
    ...patch,
  });
  if (!result.ok) throw new Error(result.message);
  return result.node;
}

const ids = (nodes: readonly PlanNode[]) => nodes.map((n) => n.nodeId);

beforeEach(async () => {
  store = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

describe('listWaitingNodes', () => {
  it('lists a node the moment it is blocked, with no wake and no ask record, and wakes the Action Center', async () => {
    const channel = StreamKeys.actionCenterWakeChannel(TENANT, SPACE);
    const woken: string[] = [];
    const subscriber = redis.duplicate();
    await subscriber.subscribe(channel);
    subscriber.on('message', (_channel: string, message: string) => woken.push(message));

    const step = await blocked('Approve the next step');

    expect(await redis.get(askedKey(TENANT, SPACE, step.nodeId))).toBeNull();
    expect(ids(await listWaitingNodes(ctx()))).toEqual([step.nodeId]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The write's wake is what rebuilds the space's Action Center: one rebuild lists it.
    expect(woken.map((m) => (JSON.parse(m) as { source: string }).source)).toContain(
      'plan_node_write',
    );
    subscriber.disconnect();
  });

  it('still lists a node whose ask record has lapsed', async () => {
    const step = await blocked('Asked a week ago');
    expect(await claimAsk(ctx(), step, null, false)).toBe(true);
    expect(isAsked(step, await redis.get(askedKey(TENANT, SPACE, step.nodeId)))).toBe(true);
    await redis.del(askedKey(TENANT, SPACE, step.nodeId));

    expect(ids(await listWaitingNodes(ctx()))).toEqual([step.nodeId]);
    expect(await findWaitingNode(ctx(), step.nodeId)).toMatchObject({ nodeId: step.nodeId });
  });

  it('lists at most its limit, the newest first by updatedAt', async () => {
    const made: PlanNode[] = [];
    for (let i = 0; i < 60; i++) made.push(await blocked(`Step ${String(i)}`));
    // The fake store's clock moves on every write, so creation order is updatedAt order.
    const listed = await listWaitingNodes(ctx());
    expect(listed).toHaveLength(PLAN_OPEN_ASKS_LIMIT);
    expect(ids(listed)).toEqual(ids(made.slice(-PLAN_OPEN_ASKS_LIMIT).reverse()));

    // A write to an older node brings it to the front.
    const touched = await write(made[0]!, { note: 'The operator added context' });
    expect((await listWaitingNodes(ctx()))[0]?.nodeId).toBe(touched.nodeId);
  });

  it('lists exactly its limit where the space holds exactly that many', async () => {
    for (let i = 0; i < PLAN_OPEN_ASKS_LIMIT; i++) await blocked(`Step ${String(i)}`);
    expect(await listWaitingNodes(ctx())).toHaveLength(PLAN_OPEN_ASKS_LIMIT);
  });

  it('does not list a stranded node, open under a closed parent', async () => {
    const parent = await node('Closed branch');
    const stranded = await blocked('Stranded', { parentId: parent.nodeId });
    await write(parent, { status: 'dropped', outcome: 'Dropped by the operator' });

    expect(await listWaitingNodes(ctx())).toEqual([]);
    expect(await findWaitingNode(ctx(), stranded.nodeId)).toBeNull();
  });

  it('lists a merge wait by the walk’s flag, and leaves out a decision and an active step', async () => {
    const merge = await node('Merge to judge');
    await write(merge, { note: `Operator context\n${PLAN_NODE_MERGE_WAIT_LINE}` });
    await node('Running step');
    await node('A choice', { kind: 'decide', proposed: 'Which way?' });

    const walk = await store.walk(SPACE, {
      statuses: OPEN_PLAN_NODE_STATUSES,
      maxDepth: 10,
      maxNodes: 100,
    });
    // The merge-wait line sits below the first line, which is all a summary carries.
    expect(walk.nodes.filter((n) => n.mergeWait === true).map((n) => n.nodeId)).toEqual([
      merge.nodeId,
    ]);
    expect(ids(await listWaitingNodes(ctx()))).toEqual([merge.nodeId]);
  });
});

describe('isWaitingPlanNode', () => {
  it('keeps an open blocked node or a merge wait, and nothing else', () => {
    expect(isWaitingPlanNode({ kind: 'execute', status: 'blocked' })).toBe(true);
    expect(isWaitingPlanNode({ kind: 'execute', status: 'active', mergeWait: true })).toBe(true);
    expect(isWaitingPlanNode({ kind: 'execute', status: 'waiting', mergeWait: true })).toBe(true);
    expect(isWaitingPlanNode({ kind: 'execute', status: 'active' })).toBe(false);
    expect(isWaitingPlanNode({ kind: 'decide', status: 'blocked' })).toBe(false);
    expect(isWaitingPlanNode({ kind: 'execute', status: 'done', mergeWait: true })).toBe(false);
    expect(isWaitingPlanNode({ kind: 'execute', status: 'dropped' })).toBe(false);
  });
});
