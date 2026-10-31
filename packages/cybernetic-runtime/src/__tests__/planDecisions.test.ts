/**
 * The decisions a plan asks of the operator (Plan 322 P3.2): every open
 * `decide` node under an open branch, read the way the Action Center lists
 * them, and the wake a node write sends so the Action Center shows the change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  PLAN_OPEN_DECISIONS_LIMIT,
  StreamKeys,
  type PlanNode,
  type PlanNodeCreateInput,
} from '@aflow/schemas';
import {
  createPlanNode,
  findOpenDecision,
  linkPlanNode,
  listOpenDecisions,
  updatePlanNode,
  type PlanWriteContext,
} from '../plan/operations.js';
import { InMemoryPlanNodeStore } from './planStoreFake.js';

const TENANT = 'a0000000-0000-4000-8000-000000000322';
const SPACE = '5e1d0000-0000-4000-8000-000000000322';
const OTHER_SPACE = '5e1d0000-0000-4000-8000-000000000999';

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

async function close(target: PlanNode, status: 'done' | 'dropped'): Promise<PlanNode> {
  const now = await store.find(target.spaceId, target.nodeId);
  const result = await updatePlanNode(ctx(target.spaceId), {
    nodeId: target.nodeId,
    expectedRevision: now!.revision,
    status,
    outcome: `${status} by the operator`,
  });
  if (!result.ok) throw new Error(result.message);
  return result.node;
}

const titles = (nodes: readonly PlanNode[]) => nodes.map((n) => n.title);

beforeEach(async () => {
  store = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

describe('listOpenDecisions', () => {
  it('lists every open decide node in tree order, each read in full', async () => {
    const root = await node('root');
    await node('build it', { parentId: root.nodeId });
    const second = await node('second choice', {
      parentId: root.nodeId,
      kind: 'decide',
      position: 5,
    });
    await node('first choice', {
      parentId: root.nodeId,
      kind: 'decide',
      position: 1,
      goal: 'Which way?',
    });
    await node('blocked choice', { kind: 'decide' });
    await close(await node('settled choice', { parentId: root.nodeId, kind: 'decide' }), 'done');

    const decisions = await listOpenDecisions(ctx());

    expect(titles(decisions)).toEqual(['first choice', 'second choice', 'blocked choice']);
    expect(decisions[0]).toMatchObject({
      goal: 'Which way?',
      criteria: 'Criteria of first choice.',
    });
    expect(decisions[1]?.revision).toBe(second.revision);
  });

  it('leaves out a decision under a closed branch, and one in another space', async () => {
    const dropped = await node('dropped branch');
    await node('orphaned choice', { parentId: dropped.nodeId, kind: 'decide' });
    await close(dropped, 'dropped');
    await node('elsewhere', { kind: 'decide' }, OTHER_SPACE);

    expect(await listOpenDecisions(ctx())).toEqual([]);
  });

  it('lists at most its limit', async () => {
    for (let i = 0; i <= PLAN_OPEN_DECISIONS_LIMIT; i++) {
      await node(`choice ${String(i)}`, { kind: 'decide', position: i });
    }
    expect(await listOpenDecisions(ctx())).toHaveLength(PLAN_OPEN_DECISIONS_LIMIT);
  });
});

describe('findOpenDecision', () => {
  it('finds an open decision by the rule the list uses, and nothing else', async () => {
    const root = await node('root');
    const choice = await node('choice', { parentId: root.nodeId, kind: 'decide' });
    const work = await node('work', { parentId: root.nodeId });

    expect(await findOpenDecision(ctx(), choice.nodeId)).toMatchObject({ nodeId: choice.nodeId });
    expect(await findOpenDecision(ctx(), work.nodeId)).toBeNull();
    expect(await findOpenDecision(ctx(OTHER_SPACE), choice.nodeId)).toBeNull();

    await close(root, 'dropped');
    expect(await findOpenDecision(ctx(), choice.nodeId)).toBeNull();
  });

  it('is null for a decision that has been answered', async () => {
    const choice = await node('choice', { kind: 'decide' });
    await close(choice, 'done');
    expect(await findOpenDecision(ctx(), choice.nodeId)).toBeNull();
  });
});

describe('the answer, written as the node’s outcome', () => {
  it('closes the decision with the answer, compare-and-set on the revision it was asked at', async () => {
    const choice = await node('choice', { kind: 'decide' });
    const rewritten = await updatePlanNode(ctx(), {
      nodeId: choice.nodeId,
      expectedRevision: choice.revision,
      criteria: 'Decided when the operator has picked one.',
    });
    expect(rewritten.ok).toBe(true);

    const stale = await updatePlanNode(ctx(), {
      nodeId: choice.nodeId,
      expectedRevision: choice.revision,
      status: 'done',
      outcome: 'The first.',
    });
    expect(stale).toMatchObject({
      ok: false,
      code: 'PLAN_NODE_STALE',
      details: { revision: choice.revision + 1, status: 'active' },
    });

    const answered = await updatePlanNode(ctx(), {
      nodeId: choice.nodeId,
      expectedRevision: choice.revision + 1,
      status: 'done',
      outcome: 'The first.',
    });
    expect(answered).toMatchObject({ ok: true, node: { status: 'done', outcome: 'The first.' } });
  });
});

describe('the Action Center wake', () => {
  it('wakes the space’s Action Center on every node write, and not on a link', async () => {
    const publish = vi.spyOn(redis, 'publish');
    const channel = StreamKeys.actionCenterWakeChannel(TENANT, SPACE);
    const wakes = () => publish.mock.calls.filter(([to]) => to === channel).length;

    const choice = await node('choice', { kind: 'decide' });
    expect(wakes()).toBe(1);
    await close(choice, 'done');
    expect(wakes()).toBe(2);

    await linkPlanNode(ctx(), { nodeId: choice.nodeId, kind: 'finding', ref: 'F1' });
    expect(wakes()).toBe(2);
  });

  it('sends no wake for a write the engine refuses', async () => {
    const choice = await node('choice', { kind: 'decide' });
    const publish = vi.spyOn(redis, 'publish');
    await updatePlanNode(ctx(), {
      nodeId: choice.nodeId,
      expectedRevision: choice.revision + 7,
      status: 'dropped',
    });
    expect(publish).not.toHaveBeenCalled();
  });
});
