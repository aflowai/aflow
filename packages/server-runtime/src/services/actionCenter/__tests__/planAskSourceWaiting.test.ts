/**
 * The plan's Action Center source by the waiting rule (Plan 338 D1, D5): it
 * lists a node the moment it is blocked, with no wake and no ask record,
 * resolves what it listed, and titles the item from the schema's one table
 * of state labels.
 */
import { configureLogging } from '@aflow/observability';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { PLAN_NODE_MERGE_WAIT_LINE, PLAN_STATE_LABELS } from '@aflow/schemas';
import { InMemoryPlanNodeStore } from '../../../../../cybernetic-runtime/src/__tests__/planStoreFake.js';

let store: InMemoryPlanNodeStore;
vi.mock('@aflow/cybernetic-runtime', async (original) => ({
  ...(await original<typeof import('@aflow/cybernetic-runtime')>()),
  createPlanNodeStore: () => store,
  createResidentScheduleStore: () => ({}),
  requestResidentWake: vi.fn(),
}));

import { askedKey, createPlanNode, updatePlanNode } from '@aflow/cybernetic-runtime';
import type { ActionCenterContext } from '../types.js';
import { createPlanAskSource } from '../sources/planAskSource.js';

const scope = {
  tenantId: 'a0000000-0000-4000-8000-000000000338' as never,
  spaceId: '00000000-0000-4000-8000-000000000338',
};
const actor: ActionCenterContext = {
  ...scope,
  actorUserId: 'operator',
  actorSpaceRole: 'editor',
  actorIsTenantAdmin: false,
  actorIsInteractiveUser: true,
};

let redis: RedisType;

beforeEach(() => {
  configureLogging({ service: 'plan-ask-waiting-test', level: 'error', prettyPrint: false });
  store = new InMemoryPlanNodeStore();
  redis = new Redis() as unknown as RedisType;
});

afterEach(() => {
  redis.disconnect();
});

const source = () => createPlanAskSource({ redis, db: {} as never, payloadStore: {} as never });

async function blocked(title: string) {
  const created = await createPlanNode(
    { ...scope, redis, store },
    { kind: 'execute', title, goal: 'g', criteria: 'c', proposed: 'Worth doing' },
  );
  if (!created.ok) throw new Error(created.message);
  return created.node;
}

it('lists a blocked root with no steps and no wake, titled from the table, and approving it opens it', async () => {
  const node = await blocked('Approve **the next step**');
  expect(node).toMatchObject({ parentId: null, status: 'blocked' });
  expect(await redis.get(askedKey(scope.tenantId, scope.spaceId, node.nodeId))).toBeNull();

  const items = await source().listOpen(scope);
  expect(items).toMatchObject([
    {
      id: `plan-ask:${node.nodeId}`,
      kind: 'human_approval',
      origin: { type: 'plan_ask', nodeId: node.nodeId, revision: node.revision },
      // The node's markdown reaches the client as written, for it to render.
      title: 'Pending approval · Approve **the next step**',
      uiHints: { approveLabel: 'Approve', rejectLabel: 'Drop' },
    },
  ]);
  const item = items[0]!;
  expect(await source().getById(actor, item.id)).toEqual(item);

  await source().resolve(actor, item, { kind: 'approve' }, item.origin);
  expect(store.nodes.get(node.nodeId)?.status).toBe('active');
  expect(await source().listOpen(scope)).toEqual([]);
});

it('titles a merge wait Pending review and keeps Close done on its control', async () => {
  const created = await createPlanNode(
    { ...scope, redis, store },
    { kind: 'execute', title: 'Merge', goal: 'g', criteria: 'c' },
  );
  if (!created.ok) throw new Error(created.message);
  const written = await updatePlanNode(
    { ...scope, redis, store },
    {
      nodeId: created.node.nodeId,
      expectedRevision: created.node.revision,
      note: PLAN_NODE_MERGE_WAIT_LINE,
    },
  );
  expect(written.ok).toBe(true);
  expect(await source().listOpen(scope)).toMatchObject([
    { title: 'Pending review · Merge', uiHints: { approveLabel: 'Close done' } },
  ]);
});

it('writes the item title from the schema table, so a label changed there changes the item', async () => {
  await blocked('Ship it');
  const labels = PLAN_STATE_LABELS.itemTitle as { blocked: string };
  const before = labels.blocked;
  labels.blocked = 'Awaiting sign-off';
  try {
    expect((await source().listOpen(scope))[0]?.title).toBe('Awaiting sign-off · Ship it');
  } finally {
    labels.blocked = before;
  }
});
