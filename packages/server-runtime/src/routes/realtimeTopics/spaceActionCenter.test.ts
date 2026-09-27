import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCenterItem, ServerRealtimeMessage, TenantId } from '@aflow/schemas';
import { StreamKeys } from '@aflow/schemas';
import { createFakeRedisBus, type FakeRedisBus } from './__tests__/fakeRedisBus.js';

let bus: FakeRedisBus;

// The focus subscriber is minted through @aflow/redis rather than duplicated
// off the caller's client, so that is the seam the fake has to occupy.
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
    async (_db: unknown, tenantId: string, spaceId: string, actor: TestActor) => ({
      tenantId,
      spaceId,
      actorUserId: actor.userId,
      actorSpaceRole: ROLES[actor.userId] ?? 'editor',
      actorIsTenantAdmin: actor.isTenantAdmin,
    }),
  ),
}));

const { ENTITY_EVENTS_PUBSUB_CHANNEL } = await import('@aflow/redis');
const { createSpaceActionCenterTopicHandler, REBUILD_FLOOR_MS } =
  await import('./spaceActionCenter.js');
const { projectActionCenterItem } = await import('../../services/actionCenter/authz.js');
type PooledItem = Parameters<typeof projectActionCenterItem>[1];

interface TestActor {
  userId: string;
  isTenantAdmin: boolean;
}

const TENANT_ID = '00000000-0000-0000-0000-000000000001' as TenantId;
const SPACE_ID = '00000000-0000-0000-0000-0000000000a1';

const EDITOR = 'user-editor';
const VIEWER = 'user-viewer';
const TENANT_ADMIN = 'user-tenant-admin';
const INVITEE = 'user-invitee';

/** Space role per test user — the mocked actor resolver reads this. */
const ROLES: Record<string, 'admin' | 'editor' | 'viewer'> = {
  [EDITOR]: 'editor',
  [VIEWER]: 'viewer',
  [TENANT_ADMIN]: 'admin',
  [INVITEE]: 'editor',
};

// ============================================================================
// Item fixtures — the actor-free shape a source produces
// ============================================================================

function approvalItem(overrides: { id?: string; pauseToken?: string } = {}): PooledItem {
  const id = overrides.id ?? 'step:step-1';
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
      ...(overrides.pauseToken ? { pauseToken: overrides.pauseToken } : {}),
      operationId: 'user.interaction.approve',
    },
    title: 'Approve the thing',
    summary: 'A step needs approval before continuing.',
    requestedAt: '2026-06-04T00:00:00.000Z',
    requestedBy: { kind: 'agent', label: 'Agent', sessionId: 'run-1' },
    priority: 'normal',
    relatesTo: [],
    resolverAuthority: { kind: 'space' },
    status: 'open',
  };
}

function tenantGrantItem(): PooledItem {
  return {
    id: 'settings:integration-host-req-1',
    spaceId: SPACE_ID,
    kind: 'human_approval',
    origin: {
      type: 'settings',
      recordKind: 'integration_host_request',
      recordId: 'req-1',
      recordVersion: 0,
    },
    title: 'Integration host: api.example.com',
    summary: 'Allow API integrations to reach api.example.com (tenant-wide allowlist)',
    requestedAt: '2026-06-04T00:00:00.000Z',
    requestedBy: { kind: 'system', label: 'unknown' },
    priority: 'high',
    relatesTo: [],
    resolverPolicy: { minResolvers: 1, requireAll: false, candidateResolvers: ['admin'] },
    resolverAuthority: { kind: 'tenant_admin' },
    status: 'open',
  };
}

function invitationItem(inviteeUserId: string): PooledItem {
  return {
    id: `session-invite:sess-1:${inviteeUserId}`,
    spaceId: SPACE_ID,
    kind: 'session_invitation',
    origin: {
      type: 'session_invitation',
      sessionId: 'sess-1',
      inviteeUserId,
      generation: 1,
    },
    title: 'Session invitation',
    summary: 'A teammate invited you to join a session.',
    requestedAt: '2026-06-04T00:00:00.000Z',
    requestedBy: { kind: 'system', label: 'Session invitation' },
    priority: 'normal',
    relatesTo: [],
    resolverAuthority: { kind: 'named_user', userId: inviteeUserId },
    status: 'open',
  };
}

// ============================================================================
// Fake aggregator — the space-scoped pool and the one source whose row set is
// the reader's own, which is the split the topic reads.
// ============================================================================

interface TestAggregator {
  listSpaceScoped: (scope: { tenantId: TenantId; spaceId: string }) => Promise<PooledItem[]>;
  listActorScoped: (ctx: { actorUserId: string }) => Promise<PooledItem[]>;
  setShared: (items: PooledItem[]) => void;
  setInvitations: (items: PooledItem[]) => void;
  failNextShared: (times?: number) => void;
  gateNextShared: () => { release: () => void; entered: Promise<void> };
  sharedCalls: () => number;
}

function makeAggregator(initial: PooledItem[] = []): TestAggregator {
  let shared = initial;
  let invitations: PooledItem[] = [];
  let sharedCalls = 0;
  let failures = 0;
  let gate: { promise: Promise<void>; enter: () => void } | null = null;

  return {
    listSpaceScoped: async () => {
      sharedCalls += 1;
      // Read up front: a gated read models a slow reply, not a read that
      // observes writes landing after it was issued.
      const captured = shared;
      if (gate) {
        const held = gate;
        gate = null;
        held.enter();
        await held.promise;
      }
      if (failures > 0) {
        failures -= 1;
        throw new Error('source read failed');
      }
      return captured;
    },
    listActorScoped: async (ctx) => {
      return invitations.filter(
        (i) => i.origin.type === 'session_invitation' && i.origin.inviteeUserId === ctx.actorUserId,
      );
    },
    setShared: (items) => {
      shared = items;
    },
    setInvitations: (items) => {
      invitations = items;
    },
    failNextShared: (times = 1) => {
      failures = times;
    },
    gateNextShared: () => {
      let release!: () => void;
      const promise = new Promise<void>((r) => {
        release = r;
      });
      let enter!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      gate = { promise, enter };
      return { release, entered };
    },
    sharedCalls: () => sharedCalls,
  };
}

// ============================================================================
// Harness
// ============================================================================

const fakeDb = {} as unknown as PostgresJsDatabase;

function makeEmitSpy(): {
  emit: (msg: ServerRealtimeMessage) => void;
  emitted: ServerRealtimeMessage[];
} {
  const emitted: ServerRealtimeMessage[] = [];
  return {
    emit: (msg) => {
      emitted.push(msg);
    },
    emitted,
  };
}

function makeCtx(args: {
  emit: (msg: ServerRealtimeMessage) => void;
  subscriptionId?: string;
  userId?: string;
}): Parameters<ReturnType<typeof createSpaceActionCenterTopicHandler>['subscribe']>[0] {
  const userId = args.userId ?? EDITOR;
  return {
    connection: {
      tenantId: TENANT_ID,
      userId,
      token: { authMethod: 'dev_bypass' },
    },
    topic: { kind: 'space.action_center', spaceId: SPACE_ID },
    subscriptionId: args.subscriptionId ?? 'sub-1',
    topicKey: `space.action_center:${SPACE_ID}`,
    emit: args.emit,
  } as unknown as Parameters<
    ReturnType<typeof createSpaceActionCenterTopicHandler>['subscribe']
  >[0];
}

function makeHandler(aggregator: TestAggregator) {
  return createSpaceActionCenterTopicHandler({
    db: fakeDb,
    redis: bus.client,
    aggregator: aggregator as never,
  });
}

async function subscribeOne(args: {
  handler: ReturnType<typeof createSpaceActionCenterTopicHandler>;
  subscriptionId?: string;
  userId?: string;
}) {
  const spy = makeEmitSpy();
  const ctx = makeCtx({
    emit: spy.emit,
    ...(args.subscriptionId !== undefined ? { subscriptionId: args.subscriptionId } : {}),
    ...(args.userId !== undefined ? { userId: args.userId } : {}),
  });
  const result = await args.handler.subscribe(ctx);
  if (result.kind !== 'accepted') throw new Error(`expected accepted, got ${result.kind}`);
  return { result, ...spy };
}

/** Let every pending continuation and residual timer run. */
async function converge(): Promise<void> {
  for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1_000);
}

type Delta =
  | { kind: 'insert'; items: ActionCenterItem[] }
  | { kind: 'update'; items: ActionCenterItem[] }
  | { kind: 'resolve'; itemIds: string[] }
  | { kind: 'focus'; message: { itemId: string } };

function deltas(emitted: ServerRealtimeMessage[]): Delta[] {
  return emitted
    .filter((m): m is Extract<ServerRealtimeMessage, { type: 'event' }> => m.type === 'event')
    .map((m) => m.event as Delta);
}

function snapshotItems(emitted: ServerRealtimeMessage[]): ActionCenterItem[] | null {
  const snap = emitted.find((m) => m.type === 'snapshot');
  if (!snap || snap.type !== 'snapshot') return null;
  return (snap.data as { items: ActionCenterItem[] }).items;
}

/** What the reader believes after folding its snapshot and every delta. */
function observed(emitted: ServerRealtimeMessage[]): Map<string, ActionCenterItem> {
  const state = new Map<string, ActionCenterItem>();
  for (const m of emitted) {
    if (m.type === 'snapshot') {
      state.clear();
      for (const it of (m.data as { items: ActionCenterItem[] }).items) state.set(it.id, it);
    }
    if (m.type === 'event') {
      const d = m.event as Delta;
      if (d.kind === 'insert' || d.kind === 'update')
        for (const it of d.items) state.set(it.id, it);
      if (d.kind === 'resolve') for (const id of d.itemIds) state.delete(id);
    }
  }
  return state;
}

async function publishFocus(itemId: string): Promise<void> {
  await bus.client.publish(
    StreamKeys.actionCenterFocusChannel(TENANT_ID, SPACE_ID),
    JSON.stringify({ itemId, ts: Date.now(), tenantId: TENANT_ID, spaceId: SPACE_ID }),
  );
}

async function publishWake(): Promise<void> {
  await bus.client.publish(
    StreamKeys.actionCenterWakeChannel(TENANT_ID, SPACE_ID),
    JSON.stringify({ source: 'test', ts: Date.now(), tenantId: TENANT_ID, spaceId: SPACE_ID }),
  );
}

// ============================================================================

describe('space.action_center subscription lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bus = createFakeRedisBus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits exactly one snapshot on start() and arms one pubsub connection', async () => {
    const agg = makeAggregator([approvalItem()]);
    const handler = makeHandler(agg);

    const { result, emitted } = await subscribeOne({ handler });
    await result.start?.();

    expect(emitted.filter((m) => m.type === 'snapshot')).toHaveLength(1);
    expect(snapshotItems(emitted)?.map((i) => i.id)).toEqual(['step:step-1']);
    expect(bus.subscribers).toHaveLength(1);
    // Space wake + tenant wake + entity events + focus share the connection.
    expect(bus.subscribers[0]?.subscribed.size).toBe(4);

    await result.cleanup();
  });

  it('coalesces concurrent first-subscribers into one bootstrap pass', async () => {
    const agg = makeAggregator([approvalItem()]);
    const handler = makeHandler(agg);

    const [a, b] = await Promise.all([
      subscribeOne({ handler, subscriptionId: 'sub-a' }),
      subscribeOne({ handler, subscriptionId: 'sub-b' }),
    ]);
    await Promise.all([a.result.start?.(), b.result.start?.()]);

    expect(agg.sharedCalls()).toBe(1);
    expect(bus.subscribers).toHaveLength(1);
    expect(snapshotItems(a.emitted)).toHaveLength(1);
    expect(snapshotItems(b.emitted)).toHaveLength(1);

    await Promise.all([a.result.cleanup(), b.result.cleanup()]);
  });

  it('emits reconcile_required when bootstrap fails, and a later subscribe re-bootstraps', async () => {
    const agg = makeAggregator([approvalItem()]);
    agg.failNextShared();
    const handler = makeHandler(agg);

    const first = await subscribeOne({ handler, subscriptionId: 'sub-a' });
    await first.result.start?.();

    const reconcile = first.emitted.find((m) => m.type === 'reconcile_required');
    expect(reconcile).toBeDefined();
    if (reconcile?.type === 'reconcile_required') {
      expect(reconcile.reason).toBe('snapshot_failed');
    }
    await first.result.cleanup();

    const second = await subscribeOne({ handler, subscriptionId: 'sub-b' });
    await second.result.start?.();
    expect(snapshotItems(second.emitted)).toHaveLength(1);

    await second.result.cleanup();
  });

  it('leaves nothing running when unsubscribe races bootstrap', async () => {
    const agg = makeAggregator([approvalItem()]);
    const handler = makeHandler(agg);
    const gate = agg.gateNextShared();

    const { result, emitted } = await subscribeOne({ handler });
    const started = result.start?.();
    await gate.entered;
    const cleanupP = result.cleanup();
    gate.release();
    await cleanupP;
    await started;

    expect(emitted.filter((m) => m.type === 'snapshot')).toHaveLength(0);

    const callsAtTeardown = agg.sharedCalls();
    await converge();
    expect(agg.sharedCalls()).toBe(callsAtTeardown);
    for (const sub of bus.subscribers) expect(sub.subscribed.size).toBe(0);
  });

  it('keeps the pool alive when one of two bootstrap-pending subscribers leaves', async () => {
    const agg = makeAggregator([approvalItem()]);
    const handler = makeHandler(agg);
    const gate = agg.gateNextShared();

    const staying = await subscribeOne({ handler, subscriptionId: 'sub-stay' });
    const leaving = await subscribeOne({ handler, subscriptionId: 'sub-leave' });
    const stayStarted = staying.result.start?.();
    const leaveStarted = leaving.result.start?.();
    await gate.entered;

    const leaveCleanup = leaving.result.cleanup();
    gate.release();
    await Promise.all([leaveCleanup, stayStarted, leaveStarted]);

    expect(snapshotItems(staying.emitted)).toHaveLength(1);
    expect(snapshotItems(leaving.emitted)).toBeNull();

    await staying.result.cleanup();
  });

  it('tears the pubsub connection down exactly once when the last subscriber leaves', async () => {
    const agg = makeAggregator([approvalItem()]);
    const handler = makeHandler(agg);

    const a = await subscribeOne({ handler, subscriptionId: 'sub-a' });
    const b = await subscribeOne({ handler, subscriptionId: 'sub-b' });
    await Promise.all([a.result.start?.(), b.result.start?.()]);

    await a.result.cleanup();
    expect(bus.subscribers[0]?.quitCalls).toBe(0);
    await b.result.cleanup();
    expect(bus.subscribers[0]?.quitCalls).toBe(1);
  });
});

describe('space.action_center delta derivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bus = createFakeRedisBus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits insert for a new item', async () => {
    const agg = makeAggregator([]);
    const handler = makeHandler(agg);
    const { result, emitted } = await subscribeOne({ handler });
    await result.start?.();
    await converge();

    agg.setShared([approvalItem()]);
    await publishWake();
    await converge();

    expect(observed(emitted).has('step:step-1')).toBe(true);
    expect(deltas(emitted).some((d) => d.kind === 'insert')).toBe(true);

    await result.cleanup();
  });

  it('emits update when the item marker changes, and nothing when it does not', async () => {
    const agg = makeAggregator([approvalItem({ pauseToken: 'tok-1' })]);
    const handler = makeHandler(agg);
    const { result, emitted } = await subscribeOne({ handler });
    await result.start?.();
    await converge();

    agg.setShared([approvalItem({ pauseToken: 'tok-1' })]);
    await publishWake();
    await converge();
    expect(deltas(emitted)).toHaveLength(0);

    const changed = approvalItem({ pauseToken: 'tok-1' });
    changed.status = 'resolved';
    agg.setShared([changed]);
    await publishWake();
    await converge();

    expect(deltas(emitted).some((d) => d.kind === 'update')).toBe(true);
    expect(observed(emitted).get('step:step-1')?.status).toBe('resolved');

    await result.cleanup();
  });

  it('emits resolve when an item disappears', async () => {
    const agg = makeAggregator([approvalItem()]);
    const handler = makeHandler(agg);
    const { result, emitted } = await subscribeOne({ handler });
    await result.start?.();
    await converge();

    agg.setShared([]);
    await publishWake();
    await converge();

    expect(observed(emitted).size).toBe(0);
    expect(deltas(emitted).some((d) => d.kind === 'resolve')).toBe(true);

    await result.cleanup();
  });

  it('passes a focus message through to every subscriber', async () => {
    const agg = makeAggregator([approvalItem()]);
    const handler = makeHandler(agg);
    const a = await subscribeOne({ handler, subscriptionId: 'sub-a' });
    const b = await subscribeOne({ handler, subscriptionId: 'sub-b', userId: VIEWER });
    await Promise.all([a.result.start?.(), b.result.start?.()]);
    await converge();

    await publishFocus('step:step-1');
    await converge();

    for (const spy of [a, b]) {
      const focus = deltas(spy.emitted).find((d) => d.kind === 'focus');
      expect(focus).toBeDefined();
      if (focus?.kind === 'focus') expect(focus.message.itemId).toBe('step:step-1');
    }

    await Promise.all([a.result.cleanup(), b.result.cleanup()]);
  });

  it('does not resolve every item when a source read fails, and recovers after', async () => {
    const agg = makeAggregator([approvalItem()]);
    const handler = makeHandler(agg);
    const { result, emitted } = await subscribeOne({ handler });
    await result.start?.();
    await converge();

    agg.failNextShared(1);
    await publishWake();
    await converge();
    expect(deltas(emitted).some((d) => d.kind === 'resolve')).toBe(false);
    expect(observed(emitted).has('step:step-1')).toBe(true);

    agg.setShared([approvalItem(), approvalItem({ id: 'step:step-2' })]);
    await publishWake();
    await converge();
    expect(observed(emitted).size).toBe(2);

    await result.cleanup();
  });

  it('serves a change that lands between subscribe() and start() without duplicating it', async () => {
    const agg = makeAggregator([]);
    const handler = makeHandler(agg);
    const gate = agg.gateNextShared();

    const { result, emitted } = await subscribeOne({ handler });
    const started = result.start?.();
    await gate.entered;
    // The wake lands while the boot read is in flight: it must queue a rebuild
    // rather than vanish into a snapshot that predates it.
    agg.setShared([approvalItem()]);
    await publishWake();
    gate.release();
    await started;
    await converge();

    expect(observed(emitted).has('step:step-1')).toBe(true);
    const insertedIds = deltas(emitted).flatMap((d) =>
      d.kind === 'insert' ? d.items.map((i) => i.id) : [],
    );
    const snapshotIds = snapshotItems(emitted)?.map((i) => i.id) ?? [];
    expect([...insertedIds, ...snapshotIds].filter((id) => id === 'step:step-1')).toHaveLength(1);

    await result.cleanup();
  });
});

describe('space.action_center wake machinery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bus = createFakeRedisBus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds on a wake, with no clock involved', async () => {
    const agg = makeAggregator([]);
    const handler = makeHandler(agg);
    const { result, emitted } = await subscribeOne({ handler });
    await result.start?.();

    agg.setShared([approvalItem()]);
    await publishWake();
    await vi.advanceTimersByTimeAsync(1);

    expect(observed(emitted).has('step:step-1')).toBe(true);
    await result.cleanup();
  });

  it('rebuilds on the tenant-wide wake channel', async () => {
    const agg = makeAggregator([]);
    const handler = makeHandler(agg);
    const { result, emitted } = await subscribeOne({ handler });
    await result.start?.();

    agg.setShared([tenantGrantItem()]);
    await bus.client.publish(
      StreamKeys.actionCenterTenantWakeChannel(TENANT_ID),
      JSON.stringify({ source: 'test', ts: Date.now(), tenantId: TENANT_ID }),
    );
    await converge();

    expect(observed(emitted).has('settings:integration-host-req-1')).toBe(true);
    await result.cleanup();
  });

  it('rebuilds on a space entity event', async () => {
    const agg = makeAggregator([]);
    const handler = makeHandler(agg);
    const { result, emitted } = await subscribeOne({ handler });
    await result.start?.();

    agg.setShared([approvalItem()]);
    await bus.client.publish(
      ENTITY_EVENTS_PUBSUB_CHANNEL(TENANT_ID, SPACE_ID),
      JSON.stringify({ type: 'entity_event', spaceId: SPACE_ID, eventType: 'entity.run.updated' }),
    );
    await converge();

    expect(observed(emitted).has('step:step-1')).toBe(true);
    await result.cleanup();
  });

  // The topic's declared idle budget is zero: every rebuild answers a wake, a
  // join, or a reconnect. A timer reintroduced here would bill every subscribed
  // space forever, so time passing must move nothing on its own.
  it('arms no timer — elapsed time alone never rebuilds', async () => {
    const agg = makeAggregator([]);
    const handler = makeHandler(agg);
    const { result, emitted } = await subscribeOne({ handler });
    await result.start?.();
    await converge();

    bus.setPublishDelivery(false);
    agg.setShared([approvalItem()]);
    await publishWake();
    await converge();
    expect(observed(emitted).has('step:step-1')).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await converge();
    expect(observed(emitted).has('step:step-1')).toBe(false);

    // The reconnect is what closes the hole the lost publish left.
    bus.subscribers[0]!.emitReady();
    await converge();
    expect(observed(emitted).has('step:step-1')).toBe(true);

    await result.cleanup();
  });

  it('rebuilds once when the pubsub connection reconnects', async () => {
    const agg = makeAggregator([]);
    const handler = makeHandler(agg);
    const { result, emitted } = await subscribeOne({ handler });
    await result.start?.();
    await converge();

    agg.setShared([approvalItem()]);
    bus.subscribers[0]!.emitReady();
    await converge();

    expect(observed(emitted).has('step:step-1')).toBe(true);
    await result.cleanup();
  });

  it('converges a warm pool when a subscriber joins it', async () => {
    const agg = makeAggregator([]);
    const handler = makeHandler(agg);
    const a = await subscribeOne({ handler, subscriptionId: 'sub-a' });
    await a.result.start?.();
    await converge();

    // A change whose wake was lost while only `a` watched.
    agg.setShared([approvalItem()]);

    const b = await subscribeOne({ handler, subscriptionId: 'sub-b', userId: VIEWER });
    await b.result.start?.();
    await converge();

    expect(observed(a.emitted).has('step:step-1')).toBe(true);
    expect(observed(b.emitted).has('step:step-1')).toBe(true);

    await Promise.all([a.result.cleanup(), b.result.cleanup()]);
  });

  it('floors back-to-back wakes to one pass per interval', async () => {
    const agg = makeAggregator([]);
    const handler = makeHandler(agg);
    const { result, emitted } = await subscribeOne({ handler });
    await result.start?.();
    const afterBoot = agg.sharedCalls();

    agg.setShared([approvalItem()]);
    await publishWake();
    await vi.advanceTimersByTimeAsync(50);
    agg.setShared([approvalItem(), approvalItem({ id: 'step:step-2' })]);
    await publishWake();
    await vi.advanceTimersByTimeAsync(50);
    // The second wake landed inside the floor window: queued, not run.
    expect(agg.sharedCalls() - afterBoot).toBe(1);
    expect(observed(emitted).has('step:step-2')).toBe(false);

    await vi.advanceTimersByTimeAsync(REBUILD_FLOOR_MS);
    expect(agg.sharedCalls() - afterBoot).toBe(2);
    expect(observed(emitted).has('step:step-2')).toBe(true);

    await result.cleanup();
  });

  it('swallows the initial ready and boots with a single source read', async () => {
    const agg = makeAggregator([approvalItem()]);
    const handler = makeHandler(agg);
    const { result } = await subscribeOne({ handler });
    await result.start?.();
    await converge();

    // The fake fires `ready` on the first subscribe, as ioredis does on the
    // eager initial connect; a reconnect-rebuild there would double every
    // mount's read cost.
    expect(agg.sharedCalls()).toBe(1);

    await result.cleanup();
  });

  it('coalesces wakes landing during a rebuild into one trailing pass', async () => {
    const agg = makeAggregator([]);
    const handler = makeHandler(agg);
    const { result } = await subscribeOne({ handler });
    await result.start?.();
    const afterBoot = agg.sharedCalls();

    const gate = agg.gateNextShared();
    await publishWake();
    await gate.entered;
    await publishWake();
    await publishWake();
    gate.release();
    await converge();

    // The gated pass plus exactly one trailing pass for the queued wakes.
    expect(agg.sharedCalls() - afterBoot).toBe(2);
    await result.cleanup();
  });
});

describe('space.action_center per-reader projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bus = createFakeRedisBus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares one pool and one pubsub connection across two readers of a space', async () => {
    const agg = makeAggregator([approvalItem()]);
    const handler = makeHandler(agg);

    const a = await subscribeOne({ handler, subscriptionId: 'sub-a', userId: EDITOR });
    const b = await subscribeOne({ handler, subscriptionId: 'sub-b', userId: VIEWER });
    await Promise.all([a.result.start?.(), b.result.start?.()]);

    // One boot read, plus at most one converging rebuild for the reader that
    // joined the already-booted entry. A per-reader pool would double both.
    expect(agg.sharedCalls()).toBeLessThanOrEqual(2);
    expect(bus.subscribers).toHaveLength(1);
    await converge();

    const before = agg.sharedCalls();
    agg.setShared([approvalItem(), approvalItem({ id: 'step:step-2' })]);
    await publishWake();
    await converge();
    // One wake is one pooled rebuild; a per-reader pool would double it.
    expect(agg.sharedCalls() - before).toBe(1);

    expect(observed(a.emitted).size).toBe(2);
    expect(observed(b.emitted).size).toBe(2);

    await Promise.all([a.result.cleanup(), b.result.cleanup()]);
  });

  it('gives each reader the actions their own role allows, from one shared item', async () => {
    const agg = makeAggregator([approvalItem()]);
    const handler = makeHandler(agg);

    const editor = await subscribeOne({ handler, subscriptionId: 'sub-e', userId: EDITOR });
    const viewer = await subscribeOne({ handler, subscriptionId: 'sub-v', userId: VIEWER });
    await Promise.all([editor.result.start?.(), viewer.result.start?.()]);
    await converge();

    expect(observed(editor.emitted).get('step:step-1')?.allowedActions).toEqual([
      'approve',
      'reject',
      'reassign',
    ]);
    expect(observed(viewer.emitted).get('step:step-1')?.allowedActions).toEqual([]);

    // …and again on a delta, not only in the snapshot.
    const changed = approvalItem();
    changed.status = 'resolved';
    agg.setShared([changed]);
    await publishWake();
    await converge();

    expect(observed(editor.emitted).get('step:step-1')?.allowedActions).toEqual([
      'approve',
      'reject',
      'reassign',
    ]);
    expect(observed(viewer.emitted).get('step:step-1')?.allowedActions).toEqual([]);

    await Promise.all([editor.result.cleanup(), viewer.result.cleanup()]);
  });

  it('shows a tenant-wide grant to everyone but offers actions only to a tenant admin', async () => {
    const agg = makeAggregator([tenantGrantItem()]);
    const handler = makeHandler(agg);

    const spaceMember = await subscribeOne({ handler, subscriptionId: 'sub-s', userId: EDITOR });
    const tenantAdmin = await subscribeOne({
      handler,
      subscriptionId: 'sub-t',
      userId: TENANT_ADMIN,
    });
    await Promise.all([spaceMember.result.start?.(), tenantAdmin.result.start?.()]);
    await converge();

    const id = 'settings:integration-host-req-1';
    expect(observed(spaceMember.emitted).get(id)).toBeDefined();
    expect(observed(spaceMember.emitted).get(id)?.allowedActions).toEqual([]);
    expect(observed(tenantAdmin.emitted).get(id)?.allowedActions).toEqual(['approve', 'reject']);

    await Promise.all([spaceMember.result.cleanup(), tenantAdmin.result.cleanup()]);
  });

  it('delivers an invitation to its invitee and to nobody else in the space', async () => {
    const agg = makeAggregator([]);
    agg.setInvitations([invitationItem(INVITEE)]);
    const handler = makeHandler(agg);

    const invitee = await subscribeOne({ handler, subscriptionId: 'sub-i', userId: INVITEE });
    const bystander = await subscribeOne({ handler, subscriptionId: 'sub-b', userId: EDITOR });
    await Promise.all([invitee.result.start?.(), bystander.result.start?.()]);
    await converge();

    const id = `session-invite:sess-1:${INVITEE}`;
    expect(observed(invitee.emitted).get(id)?.allowedActions).toEqual(['approve', 'reject']);
    expect(observed(bystander.emitted).has(id)).toBe(false);

    await Promise.all([invitee.result.cleanup(), bystander.result.cleanup()]);
  });

  it('delivers an invitation that arrives while both readers are connected', async () => {
    const agg = makeAggregator([]);
    const handler = makeHandler(agg);

    const invitee = await subscribeOne({ handler, subscriptionId: 'sub-i', userId: INVITEE });
    const bystander = await subscribeOne({ handler, subscriptionId: 'sub-b', userId: EDITOR });
    await Promise.all([invitee.result.start?.(), bystander.result.start?.()]);
    await converge();

    agg.setInvitations([invitationItem(INVITEE)]);
    await publishWake();
    await converge();

    const id = `session-invite:sess-1:${INVITEE}`;
    expect(observed(invitee.emitted).has(id)).toBe(true);
    expect(observed(bystander.emitted).has(id)).toBe(false);

    await Promise.all([invitee.result.cleanup(), bystander.result.cleanup()]);
  });
});
