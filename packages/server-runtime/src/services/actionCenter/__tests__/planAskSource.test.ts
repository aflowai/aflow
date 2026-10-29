import { configureLogging } from '@aflow/observability';
import { beforeEach, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { PLAN_NODE_PROSE_MAX_CHARS, PlanNodeNextInputSchema } from '@aflow/schemas';
import { InMemoryPlanNodeStore } from '../../../../../cybernetic-runtime/src/__tests__/planStoreFake.js';

let store: InMemoryPlanNodeStore;
vi.mock('@aflow/cybernetic-runtime', async (original) => ({
  ...(await original<typeof import('@aflow/cybernetic-runtime')>()),
  createPlanNodeStore: () => store,
  createResidentScheduleStore: () => ({}),
  requestResidentWake: vi.fn(),
}));

import { createPlanNode, nextOnPlanBoard, requestResidentWake } from '@aflow/cybernetic-runtime';
import type { ActionCenterContext } from '../types.js';
import { planAskItem, createPlanAskSource } from '../sources/planAskSource.js';

beforeEach(() => {
  configureLogging({ service: 'plan-ask-test', level: 'error', prettyPrint: false });
  store = new InMemoryPlanNodeStore();
});

it('produces one plan_ask item through the Action Center source across two wakes', async () => {
  const redis = new Redis() as unknown as RedisType;
  const scope = {
    tenantId: 'a0000000-0000-4000-8000-000000000001' as never,
    spaceId: '00000000-0000-4000-8000-000000000002',
  };
  const context = { ...scope, redis, store };
  await createPlanNode(context, {
    kind: 'execute',
    title: 'Approve the next step',
    goal: 'g',
    criteria: 'c',
    proposed: 'Worth doing',
  });
  const stream = { ...context, holder: 'wake-1', reads: {} as never };
  const first = await nextOnPlanBoard(stream, PlanNodeNextInputSchema.parse({}));
  expect(first).toMatchObject({
    ok: true,
    output: { decisions: [{ answer: { decision: 'ask' } }] },
  });
  const source = createPlanAskSource({ redis, db: {} as never, payloadStore: {} as never });
  const items = await source.listOpen(scope);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ origin: { type: 'plan_ask' } });
  expect(
    await nextOnPlanBoard({ ...stream, holder: 'wake-2' }, PlanNodeNextInputSchema.parse({})),
  ).toMatchObject({ ok: true, output: { decisions: [] } });
  expect(await source.listOpen(scope)).toEqual(items);
  redis.disconnect();
});

const scope = {
  tenantId: 'a0000000-0000-4000-8000-000000000001' as never,
  spaceId: '00000000-0000-4000-8000-000000000002',
};
const actor: ActionCenterContext = {
  ...scope,
  actorUserId: 'operator',
  actorSpaceRole: 'editor',
  actorIsTenantAdmin: false,
  actorIsInteractiveUser: true,
};

async function fixture(live = false) {
  const redis = new Redis() as unknown as RedisType;
  const created = await createPlanNode(
    { ...scope, redis, store },
    {
      kind: live ? 'investigate' : 'execute',
      title: 'Next',
      goal: 'Goal',
      criteria: 'Criteria',
      ...(live
        ? {
            liveCheck: {
              pullRequest: 'https://github.com/aflowai/aflow/pull/1',
              mergeCommitSha: 'abcdef123',
            },
          }
        : { proposed: 'Worth doing' }),
    },
  );
  if (!created.ok) throw new Error(created.message);
  await nextOnPlanBoard(
    { ...scope, redis, store, holder: 'ask-wake', reads: {} as never },
    PlanNodeNextInputSchema.parse({}),
  );
  return {
    redis,
    node: created.node,
    item: planAskItem(created.node),
    source: createPlanAskSource({ redis, db: {} as never, payloadStore: {} as never }),
  };
}

it.each(['approve', 'reject'] as const)(
  'resolves %s with a revision-checked plan write and wakes the resident',
  async (kind) => {
    const { source, item, node, redis } = await fixture();
    vi.mocked(requestResidentWake).mockClear();
    const result = await source.resolve(actor, item, { kind }, item.origin);
    expect(store.nodes.get(node.nodeId)).toMatchObject({
      status: kind === 'approve' ? 'active' : 'dropped',
      revision: node.revision + 1,
    });
    if (kind === 'reject')
      expect(store.nodes.get(node.nodeId)?.outcome).toContain('Dropped by the operator');
    expect(result).toMatchObject({
      dispatchedOperationId: 'plan.node.update',
      resolvedAt: expect.any(String),
    });
    expect(requestResidentWake).toHaveBeenCalledWith(expect.anything(), {
      ...scope,
      cause: 'node_written',
    });
    redis.disconnect();
  },
);

it('approves a live check as a recorded folder-head read, removes the item and commissions nothing', async () => {
  const { source, item, node, redis } = await fixture(true);
  expect(await source.listOpen(scope)).toHaveLength(1);
  await source.resolve(actor, item, { kind: 'approve' }, item.origin);
  expect(store.nodes.get(node.nodeId)).toMatchObject({
    status: 'done',
    outcome: expect.stringContaining("folder's head"),
  });
  expect(await source.listOpen(scope)).toEqual([]);
  const board = await nextOnPlanBoard(
    { ...scope, redis, store, holder: 'wake', reads: {} as never },
    PlanNodeNextInputSchema.parse({}),
  );
  expect(board).toMatchObject({ ok: true, output: { decisions: [] } });
  redis.disconnect();
});

it.each(['approve', 'reject'] as const)(
  'refuses stale %s without writing or waking',
  async (kind) => {
    const { source, item, node, redis } = await fixture();
    vi.mocked(requestResidentWake).mockClear();
    await store.updateAtRevision(scope.spaceId, node.nodeId, node.revision, {
      note: 'Operator changed this',
    });
    const before = store.nodes.get(node.nodeId);
    await expect(source.resolve(actor, item, { kind }, item.origin)).rejects.toMatchObject({
      code: 'STALE_ACTION_CENTER_ITEM',
    });
    expect(store.nodes.get(node.nodeId)).toEqual(before);
    expect(requestResidentWake).not.toHaveBeenCalled();
    redis.disconnect();
  },
);

it.each([
  'non-interactive',
  'missing-origin',
  'wrong-node',
  'wrong-origin',
  'unsupported',
] as const)('refuses %s without writing or waking', async (failure) => {
  const { source, item, node, redis } = await fixture();
  vi.mocked(requestResidentWake).mockClear();
  const observed =
    failure === 'missing-origin'
      ? undefined
      : failure === 'wrong-node'
        ? { ...item.origin, nodeId: scope.spaceId }
        : failure === 'wrong-origin'
          ? { type: 'plan_decision' as const, nodeId: node.nodeId, revision: node.revision }
          : item.origin;
  await expect(
    source.resolve(
      { ...actor, actorIsInteractiveUser: failure !== 'non-interactive' },
      item,
      failure === 'unsupported' ? { kind: 'dismiss' } : { kind: 'approve' },
      observed,
    ),
  ).rejects.toMatchObject({
    code: failure === 'non-interactive' ? 'FORBIDDEN' : 'INVALID_RESOLUTION',
  });
  expect(store.nodes.get(node.nodeId)).toEqual(node);
  expect(requestResidentWake).not.toHaveBeenCalled();
  redis.disconnect();
});

it('summarizes the wait line below an operator note', async () => {
  const { redis, item } = await fixture();
  const node = [...store.nodes.values()][0]!;
  expect(
    planAskItem({ ...node, note: 'Operator context\nWaiting on you: approve scope' }).summary,
  ).toBe('Waiting on you: approve scope');
  expect(item.origin.type).toBe('plan_ask');
  redis.disconnect();
  expect(planAskItem({ ...node, note: 'x'.repeat(PLAN_NODE_PROSE_MAX_CHARS) }).summary).toContain(
    'Waiting on you:',
  );
});

it('returns carrier failures after a committed live-check approval', async () => {
  const { source, item, node, redis } = await fixture(true);
  await store.insertLink(scope.spaceId, {
    nodeId: node.nodeId,
    kind: 'finding',
    ref: 'Open finding',
  });
  vi.spyOn(store, 'pageLinks').mockRejectedValueOnce(new Error('findings unavailable'));
  const result = await source.resolve(actor, item, { kind: 'approve' }, item.origin);
  expect(result.carrierFailure).toBe(
    `Carrier failed for closed node ${node.nodeId}. Read its linked findings and propose a blocked carrier.`,
  );
  expect(store.nodes.get(node.nodeId)?.status).toBe('done');
  redis.disconnect();
});
