import { beforeEach, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { PlanNodeNextInputSchema } from '@aflow/schemas';
import { InMemoryPlanNodeStore } from '../../../../../cybernetic-runtime/src/__tests__/planStoreFake.js';

let store: InMemoryPlanNodeStore;
vi.mock('@aflow/cybernetic-runtime', async (original) => ({
  ...(await original<typeof import('@aflow/cybernetic-runtime')>()),
  createPlanNodeStore: () => store,
  createResidentScheduleStore: () => ({}),
  requestResidentWake: vi.fn(),
}));

import { createPlanNode, nextOnPlanBoard } from '@aflow/cybernetic-runtime';
import { createPlanAskSource } from '../sources/planAskSource.js';

beforeEach(() => {
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
