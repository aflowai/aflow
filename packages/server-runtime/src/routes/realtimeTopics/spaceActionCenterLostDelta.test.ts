import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCenterItem, ServerRealtimeMessage, TenantId } from '@aflow/schemas';
import { StreamKeys } from '@aflow/schemas';
import { createFakeRedisBus, type FakeRedisBus } from './__tests__/fakeRedisBus.js';

let bus: FakeRedisBus;

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aflow/redis');
  return {
    ...actual,
    getRedisConfig: () => ({}),
    createSubscriberConnection: () => bus.mintSubscriber(),
  };
});

vi.mock('../../services/actionCenter/resolveActorContext.js', () => ({
  resolveActionCenterActorContext: vi.fn(
    async (_db: unknown, tenantId: string, spaceId: string, actor: { userId: string }) => ({
      tenantId,
      spaceId,
      actorUserId: actor.userId,
      actorSpaceRole: 'editor',
      actorIsTenantAdmin: false,
    }),
  ),
}));

const { createSpaceActionCenterTopicHandler } = await import('./spaceActionCenter.js');
const { projectActionCenterItem } = await import('../../services/actionCenter/authz.js');
type PooledItem = Parameters<typeof projectActionCenterItem>[1];

const TENANT_ID = '00000000-0000-0000-0000-000000000001' as TenantId;
const SPACE_ID = '00000000-0000-0000-0000-0000000000a1';

function approvalItem(id = 'step:step-1'): PooledItem {
  return {
    id,
    spaceId: SPACE_ID,
    kind: 'human_approval',
    origin: {
      type: 'step',
      runId: 'run-1',
      stepExecutionId: id.slice('step:'.length),
      sessionId: 'run-1',
      pauseVersion: 0,
      operationId: 'user.interaction.approve',
    },
    title: 'Approve the thing',
    summary: 'x',
    requestedAt: '2026-06-04T00:00:00.000Z',
    requestedBy: { kind: 'agent', label: 'Agent', sessionId: 'run-1' },
    priority: 'normal',
    relatesTo: [],
    resolverAuthority: { kind: 'space' },
    status: 'open',
  } as unknown as PooledItem;
}

const fakeDb = {} as unknown as PostgresJsDatabase;

/**
 * A space-wide item survives a per-reader read failing on the same cycle.
 *
 * The tick reads the space, then reads each subscriber's own rows. If it
 * advances the shared baseline before those reads, one transient failure
 * discards a delta computed against a baseline that has already moved — and the
 * next tick diffs against it, finds nothing, and the item is gone for good with
 * no reconcile hint to recover it. So every read has to happen before any
 * baseline moves, and this is what says so.
 */
describe('space delta survives a failing personal read', () => {
  beforeEach(() => {
    bus = createFakeRedisBus();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('still delivers the insert', async () => {
    let shared: PooledItem[] = [];
    let personalFails = false;
    const agg = {
      listSpaceScoped: async () => shared,
      listActorScoped: async () => {
        if (personalFails) {
          personalFails = false;
          throw new Error('invitation read failed');
        }
        return [];
      },
    };
    const handler = createSpaceActionCenterTopicHandler({
      db: fakeDb,
      redis: bus.client,
      aggregator: agg as never,
    });
    const emitted: ServerRealtimeMessage[] = [];
    const ctx = {
      connection: { tenantId: TENANT_ID, userId: 'u1', token: { authMethod: 'dev_bypass' } },
      topic: { kind: 'space.action_center', spaceId: SPACE_ID },
      subscriptionId: 'sub-1',
      topicKey: `space.action_center:${SPACE_ID}`,
      emit: (m: ServerRealtimeMessage) => emitted.push(m),
    } as never;
    const result = await handler.subscribe(ctx);
    if (result.kind !== 'accepted') throw new Error('not accepted');
    await result.start?.();

    const publishWake = async () => {
      await bus.client.publish(
        StreamKeys.actionCenterWakeChannel(TENANT_ID, SPACE_ID),
        JSON.stringify({ source: 'test', ts: Date.now(), tenantId: TENANT_ID, spaceId: SPACE_ID }),
      );
    };

    // The pending approval appears at the same moment the invitation read blips.
    shared = [approvalItem()];
    personalFails = true;
    await publishWake();
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1_000);
    // The failed pass must not have advanced the shared baseline; the next
    // wake re-derives the insert.
    await publishWake();
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1_000);

    const state = new Map<string, ActionCenterItem>();
    for (const m of emitted) {
      if (m.type === 'snapshot')
        for (const it of (m.data as { items: ActionCenterItem[] }).items) state.set(it.id, it);
      if (m.type === 'event') {
        const d = m.event as { kind: string; items?: ActionCenterItem[]; itemIds?: string[] };
        if (d.kind === 'insert' || d.kind === 'update')
          for (const it of d.items ?? []) state.set(it.id, it);
        if (d.kind === 'resolve') for (const id of d.itemIds ?? []) state.delete(id);
      }
    }
    // Twenty simulated seconds — ten refresh cycles — after the item appeared.
    expect(state.has('step:step-1')).toBe(true);

    await result.cleanup();
  });
});
