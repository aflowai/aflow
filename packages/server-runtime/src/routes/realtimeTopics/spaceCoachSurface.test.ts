import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActiveSurfaceCoach,
  ActiveSurfaceHelmsman,
  ActiveSurfaceRun,
  ActiveSurfaceSnapshot,
  ActiveSurfaceTransition,
  CoachAnomalySummary,
  CoachSurfaceSnapshot,
  EntityEventEnvelope,
  ServerRealtimeMessage,
  TenantId,
} from '@aflow/schemas';
import { createFakeRedisBus, type FakeRedisBus } from './__tests__/fakeRedisBus.js';
import {
  createSpaceCoachSurfaceTopicHandler,
  diffCoachSurface,
  type CoachSurfaceSourceDeps,
} from './spaceCoachSurface.js';

let bus: FakeRedisBus;

// The subscriber is minted through @aflow/redis rather than duplicated off the
// caller's client, so that is the seam the fake has to occupy.
vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aflow/redis');
  return {
    ...actual,
    getRedisConfig: () => ({}),
    createSubscriberConnection: () => bus.mintSubscriber(),
  };
});

const { appendEntityEvent } = await import('@aflow/redis');

vi.mock('./authz.js', () => ({
  canReadSpace: vi.fn(async () => true),
  __resetAuthzCacheForTests: () => undefined,
}));

const TENANT_ID = '00000000-0000-0000-0000-000000000001' as TenantId;
const SPACE_ID = '00000000-0000-0000-0000-0000000000a1';
const USER_ID = 'user-a';

const baseCoach: ActiveSurfaceCoach = {
  lifecycle: 'idle',
  pendingProposals: 0,
  pendingPlatformIssues: 0,
  pendingAnomalies: 0,
};

const baseHelmsman: ActiveSurfaceHelmsman = {
  sessionId: null,
  lifecycle: 'unknown',
  mode: null,
  triggerSource: null,
  lastInteractionAt: null,
};

const baseRun: ActiveSurfaceRun = {
  runId: '00000000-0000-0000-0000-000000000010',
  sessionId: null,
  skillId: null,
  skillName: null,
  workflowSlug: 'demo',
  lifecycle: 'executing',
  startedAt: '2026-06-04T00:00:00.000Z',
  endedAt: null,
  graphFidelity: 'full',
  tasks: [],
};

const baseAnomaly: CoachAnomalySummary = {
  id: '00000000-0000-0000-0000-0000000000c1',
  kind: 'repeated_failure',
  severity: 'warning',
  summary: 'sample',
  reportedAt: '2026-06-04T00:00:00.000Z',
  acknowledged: false,
  coachSessionId: '00000000-0000-0000-0000-0000000000d1',
};

const baseTransition: ActiveSurfaceTransition = {
  at: '2026-06-04T00:00:00.000Z',
  kind: 'mode',
  label: 'autonomous',
};

const baseActiveSurface: ActiveSurfaceSnapshot = {
  spaceId: SPACE_ID,
  capturedAt: '2026-06-04T00:00:00.000Z',
  activeSurfaceVersion: 'v1',
  capturedFrom: 'live',
  helmsman: baseHelmsman,
  surfacedRuns: [],
  coach: baseCoach,
  recentTransitions: [],
};

function makeSnapshot(overrides: Partial<CoachSurfaceSnapshot> = {}): CoachSurfaceSnapshot {
  return {
    coach: baseCoach,
    anomalies: [],
    helmsman: baseHelmsman,
    surfacedRuns: [],
    recentTransitions: [],
    ...overrides,
  };
}

// ============================================================================
// Pure: diffCoachSurface
// ============================================================================

describe('diffCoachSurface', () => {
  it('emits every section as a delta on first build (prev=null)', () => {
    const next = makeSnapshot({
      anomalies: [baseAnomaly],
      surfacedRuns: [baseRun],
      recentTransitions: [baseTransition],
    });
    const deltas = diffCoachSurface(null, next);
    const kinds = deltas.map((d) => d.kind);
    expect(kinds).toContain('lifecycle');
    expect(kinds).toContain('anomaly_added');
    expect(kinds).toContain('surfaced_runs');
    expect(kinds).toContain('helmsman');
    expect(kinds).toContain('transitions');
  });

  it('emits no deltas when snapshots are equal', () => {
    const snap = makeSnapshot({ anomalies: [baseAnomaly], surfacedRuns: [baseRun] });
    expect(diffCoachSurface(snap, snap)).toEqual([]);
  });

  it('emits lifecycle delta on coach.lifecycle change', () => {
    const prev = makeSnapshot();
    const next = makeSnapshot({ coach: { ...baseCoach, lifecycle: 'reviewing' } });
    const deltas = diffCoachSurface(prev, next);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toEqual({ kind: 'lifecycle', coach: next.coach });
  });

  it('emits lifecycle delta when only counts change (coach carries counts)', () => {
    const prev = makeSnapshot();
    const next = makeSnapshot({ coach: { ...baseCoach, pendingAnomalies: 3 } });
    const deltas = diffCoachSurface(prev, next);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ kind: 'lifecycle' });
  });

  it('emits anomaly_added for new anomalies and anomaly_resolved for removed ones', () => {
    const a1 = { ...baseAnomaly, id: '00000000-0000-0000-0000-0000000000a1' };
    const a2 = { ...baseAnomaly, id: '00000000-0000-0000-0000-0000000000a2' };
    const prev = makeSnapshot({ anomalies: [a1] });
    const next = makeSnapshot({ anomalies: [a2] });
    const deltas = diffCoachSurface(prev, next);
    expect(deltas).toContainEqual({ kind: 'anomaly_added', anomaly: a2 });
    expect(deltas).toContainEqual({ kind: 'anomaly_resolved', anomalyId: a1.id });
  });

  it('emits surfaced_runs when a run task status changes', () => {
    const prev = makeSnapshot({ surfacedRuns: [{ ...baseRun, tasks: [] }] });
    const next = makeSnapshot({
      surfacedRuns: [
        {
          ...baseRun,
          tasks: [
            {
              taskId: 't1',
              status: 'running',
              dependsOn: [],
              startedAt: null,
              completedAt: null,
            },
          ],
        },
      ],
    });
    const deltas = diffCoachSurface(prev, next);
    expect(deltas.find((d) => d.kind === 'surfaced_runs')).toBeDefined();
  });

  it('emits helmsman delta on helmsman.lifecycle change', () => {
    const prev = makeSnapshot();
    const next = makeSnapshot({
      helmsman: { ...baseHelmsman, lifecycle: 'executing' },
    });
    const deltas = diffCoachSurface(prev, next);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ kind: 'helmsman' });
  });

  it('emits transitions delta when recentTransitions changes', () => {
    const prev = makeSnapshot();
    const next = makeSnapshot({ recentTransitions: [baseTransition] });
    const deltas = diffCoachSurface(prev, next);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ kind: 'transitions' });
  });
});

// ============================================================================
// Integration: subscribe lifecycle
// ============================================================================

function makeRedisStub(): { redis: Redis } {
  return { redis: bus.client };
}

/** Publish a real entity event on the space channel the topic listens to. */
async function emitEntityEvent(eventType: EntityEventEnvelope['eventType']): Promise<void> {
  await appendEntityEvent(bus.client, {
    tenantId: TENANT_ID,
    spaceId: SPACE_ID,
    event: {
      eventId: randomUUID(),
      eventType,
      spaceId: SPACE_ID,
      tenantId: TENANT_ID,
      timestamp: Date.now(),
      payload: {},
      summary: eventType,
    },
  });
}

/**
 * Let every pending continuation and residual timer run. Sized well past the
 * historical 2s refresh so a poll-delivered rebuild still counts as converged.
 */
async function converge(): Promise<void> {
  for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1_000);
}

function lifecycleDeltas(emitted: ServerRealtimeMessage[]): string[] {
  return emitted
    .filter((m): m is Extract<ServerRealtimeMessage, { type: 'event' }> => m.type === 'event')
    .map((m) => m.event as { kind?: string; coach?: ActiveSurfaceCoach })
    .filter((d) => d.kind === 'lifecycle')
    .map((d) => d.coach?.lifecycle ?? '');
}

/** What the subscriber believes after folding its snapshot and every delta. */
function observedLifecycle(emitted: ServerRealtimeMessage[]): string | null {
  let lifecycle: string | null = null;
  for (const m of emitted) {
    if (m.type === 'snapshot') lifecycle = (m.data as CoachSurfaceSnapshot).coach.lifecycle;
    if (m.type === 'event') {
      const delta = m.event as { kind?: string; coach?: ActiveSurfaceCoach };
      if (delta.kind === 'lifecycle' && delta.coach) lifecycle = delta.coach.lifecycle;
    }
  }
  return lifecycle;
}

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
  topic: { kind: 'space.coach_surface'; spaceId: string };
  emit: (msg: ServerRealtimeMessage) => void;
  subscriptionId?: string;
  topicKey?: string;
  userId?: string;
}): Parameters<ReturnType<typeof createSpaceCoachSurfaceTopicHandler>['subscribe']>[0] {
  return {
    connection: {
      tenantId: TENANT_ID,
      userId: args.userId ?? USER_ID,
      token: { authMethod: 'dev_bypass' },
    },
    topic: args.topic,
    subscriptionId: args.subscriptionId ?? 'sub-1',
    topicKey: args.topicKey ?? `space.coach_surface:${args.topic.spaceId}`,
    emit: args.emit,
  } as unknown as Parameters<
    ReturnType<typeof createSpaceCoachSurfaceTopicHandler>['subscribe']
  >[0];
}

const fakeDb = {} as unknown as PostgresJsDatabase;

interface TestSource extends CoachSurfaceSourceDeps {
  setNext: (snap: CoachSurfaceSnapshot) => void;
  /** Absolute instant the source reports as its next clock-only change. */
  setDeadline: (at: number | null) => void;
  /** Hold the next build in flight until the returned release is called. */
  gateNextBuild: () => { release: () => void; entered: Promise<void> };
  buildCalls: () => number;
}

function makeSource(initial: CoachSurfaceSnapshot): TestSource {
  let next: CoachSurfaceSnapshot = initial;
  let buildCalls = 0;
  let deadlineAt: number | null = null;
  let gate: { promise: Promise<void>; resolve: () => void } | null = null;
  let entered: (() => void) | null = null;

  return {
    buildActiveSurface: async () => {
      buildCalls += 1;
      // Read the sources up front: a gated build models a slow reply, not a
      // read that observes writes landing after it was issued.
      const captured = next;
      if (gate) {
        const held = gate;
        gate = null;
        entered?.();
        entered = null;
        await held.promise;
      }
      // Mirrors the aggregator: a crossing already in the past is not reported.
      const stillAhead = deadlineAt !== null && deadlineAt > Date.now();
      return {
        ...baseActiveSurface,
        coach: captured.coach,
        helmsman: captured.helmsman,
        surfacedRuns: captured.surfacedRuns,
        recentTransitions: captured.recentTransitions,
        ...(stillAhead && deadlineAt !== null
          ? { nextTimeDerivedChangeAt: new Date(deadlineAt).toISOString() }
          : {}),
      };
    },
    listPendingAnomalies: async () => next.anomalies,
    setNext: (snap) => {
      next = snap;
    },
    setDeadline: (at) => {
      deadlineAt = at;
    },
    gateNextBuild: () => {
      let resolveGate!: () => void;
      const promise = new Promise<void>((r) => {
        resolveGate = r;
      });
      let resolveEntered!: () => void;
      const enteredPromise = new Promise<void>((r) => {
        resolveEntered = r;
      });
      gate = { promise, resolve: resolveGate };
      entered = resolveEntered;
      return { release: resolveGate, entered: enteredPromise };
    },
    buildCalls: () => buildCalls,
  };
}

describe('createSpaceCoachSurfaceTopicHandler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    bus = createFakeRedisBus();
  });

  it('emits a snapshot on start() after bootstrap completes', async () => {
    const { redis } = makeRedisStub();
    const source = makeSource(makeSnapshot({ anomalies: [baseAnomaly] }));
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });
    const { emit, emitted } = makeEmitSpy();
    const ctx = makeCtx({ topic: { kind: 'space.coach_surface', spaceId: SPACE_ID }, emit });

    const result = await handler.subscribe(ctx);
    if (result.kind !== 'accepted') throw new Error('expected accepted');
    await result.start?.();

    expect(emitted).toHaveLength(1);
    const first = emitted[0]!;
    expect(first.type).toBe('snapshot');
    if (first.type !== 'snapshot') throw new Error('expected snapshot');
    expect((first.data as CoachSurfaceSnapshot).anomalies).toHaveLength(1);

    await result.cleanup();
  });

  it('emits reconcile_required when bootstrap fails', async () => {
    const { redis } = makeRedisStub();
    const source: CoachSurfaceSourceDeps = {
      buildActiveSurface: async () => {
        throw new Error('boom');
      },
      listPendingAnomalies: async () => [],
    };
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });
    const { emit, emitted } = makeEmitSpy();
    const ctx = makeCtx({ topic: { kind: 'space.coach_surface', spaceId: SPACE_ID }, emit });

    const result = await handler.subscribe(ctx);
    if (result.kind !== 'accepted') throw new Error('expected accepted');
    await result.start?.();

    const reconcile = emitted.find((m) => m.type === 'reconcile_required');
    expect(reconcile).toBeDefined();
    if (reconcile && reconcile.type === 'reconcile_required') {
      expect(reconcile.reason).toBe('snapshot_failed');
    }

    // The channel is live before the snapshot exists, so a failed boot has to
    // take its subscription down rather than leave it waking a dropped entry.
    expect(bus.subscribers[0]?.quitCalls).toBe(1);

    await result.cleanup();
  });

  it('coalesces concurrent first-subscribers into one bootstrap pass', async () => {
    const { redis } = makeRedisStub();
    const source = makeSource(makeSnapshot());
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });

    const a = makeEmitSpy();
    const b = makeEmitSpy();
    const ctxA = makeCtx({
      topic: { kind: 'space.coach_surface', spaceId: SPACE_ID },
      emit: a.emit,
      subscriptionId: 'sub-a',
    });
    const ctxB = makeCtx({
      topic: { kind: 'space.coach_surface', spaceId: SPACE_ID },
      emit: b.emit,
      subscriptionId: 'sub-b',
    });

    const [ra, rb] = await Promise.all([handler.subscribe(ctxA), handler.subscribe(ctxB)]);
    if (ra.kind !== 'accepted' || rb.kind !== 'accepted') throw new Error('expected accepted');
    await Promise.all([ra.start?.(), rb.start?.()]);

    expect(source.buildCalls()).toBe(1);
    expect(a.emitted.find((m) => m.type === 'snapshot')).toBeDefined();
    expect(b.emitted.find((m) => m.type === 'snapshot')).toBeDefined();

    await Promise.all([ra.cleanup(), rb.cleanup()]);
  });

  it('keeps pool alive when one of two bootstrap-pending subscribers leaves', async () => {
    const { redis } = makeRedisStub();
    let resolveFirstBuild!: () => void;
    let firstBuildCount = 0;
    const source: CoachSurfaceSourceDeps = {
      buildActiveSurface: async () => {
        firstBuildCount += 1;
        if (firstBuildCount === 1) {
          await new Promise<void>((resolve) => {
            resolveFirstBuild = resolve;
          });
        }
        return {
          ...baseActiveSurface,
          coach: baseCoach,
          helmsman: baseHelmsman,
          surfacedRuns: [],
          recentTransitions: [],
        };
      },
      listPendingAnomalies: async () => [],
    };
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });

    const staying = makeEmitSpy();
    const leaving = makeEmitSpy();
    const ctxStay = makeCtx({
      topic: { kind: 'space.coach_surface', spaceId: SPACE_ID },
      emit: staying.emit,
      subscriptionId: 'sub-stay',
    });
    const ctxLeave = makeCtx({
      topic: { kind: 'space.coach_surface', spaceId: SPACE_ID },
      emit: leaving.emit,
      subscriptionId: 'sub-leave',
    });

    const [rStay, rLeave] = await Promise.all([
      handler.subscribe(ctxStay),
      handler.subscribe(ctxLeave),
    ]);
    if (rStay.kind !== 'accepted' || rLeave.kind !== 'accepted')
      throw new Error('expected accepted');

    const leaveCleanup = rLeave.cleanup();
    resolveFirstBuild();
    await leaveCleanup;

    await rStay.start?.();

    expect(staying.emitted.find((m) => m.type === 'snapshot')).toBeDefined();
    expect(leaving.emitted.find((m) => m.type === 'snapshot')).toBeUndefined();

    await rStay.cleanup();
  });

  it('start() no-ops when unsubscribe races bootstrap (no leaked pool entry)', async () => {
    const { redis } = makeRedisStub();
    let resolveFirstBuild!: () => void;
    let firstBuildCount = 0;
    const source: CoachSurfaceSourceDeps = {
      buildActiveSurface: async () => {
        firstBuildCount += 1;
        if (firstBuildCount === 1) {
          await new Promise<void>((resolve) => {
            resolveFirstBuild = resolve;
          });
        }
        return {
          ...baseActiveSurface,
          coach: baseCoach,
          helmsman: baseHelmsman,
          surfacedRuns: [],
          recentTransitions: [],
        };
      },
      listPendingAnomalies: async () => [],
    };
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });

    const { emit, emitted } = makeEmitSpy();
    const ctx = makeCtx({ topic: { kind: 'space.coach_surface', spaceId: SPACE_ID }, emit });

    const result = await handler.subscribe(ctx);
    if (result.kind !== 'accepted') throw new Error('expected accepted');

    // Tear down before the first bootstrap finishes — start() must not
    // bootstrap a fresh pool entry or emit to this subscription.
    const cleanupP = result.cleanup();
    resolveFirstBuild();
    await cleanupP;
    await result.start?.();

    // No snapshot (and no orphan pool timer/pubsub from a re-bootstrap).
    const snapshots = emitted.filter((m) => m.type === 'snapshot');
    expect(snapshots).toHaveLength(0);
  });

  it('kicks an early tick when the pub/sub channel fires an entity event', async () => {
    const { redis } = makeRedisStub();
    const source = makeSource(makeSnapshot());
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });

    const { emit, emitted } = makeEmitSpy();
    const ctx = makeCtx({ topic: { kind: 'space.coach_surface', spaceId: SPACE_ID }, emit });

    const result = await handler.subscribe(ctx);
    if (result.kind !== 'accepted') throw new Error('expected accepted');
    await result.start?.();

    source.setNext(makeSnapshot({ coach: { ...baseCoach, lifecycle: 'reviewing' } }));
    await emitEntityEvent('entity.coach.activated');

    // Allow the awaited buildSnapshot to settle.
    await new Promise<void>((r) => {
      setTimeout(r, 10);
    });

    expect(lifecycleDeltas(emitted)).toContain('reviewing');

    await result.cleanup();
  });
});

// ============================================================================
// Convergence: what must still hold once the refresh interval is gone
//
// Every case asserts only that the subscriber ends up with the change — never
// how fast. Each passed while a 2s poll was the thing delivering it, so a
// wrong primary path fails them rather than quietly measuring nothing.
// ============================================================================

describe('space.coach_surface convergence', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    bus = createFakeRedisBus();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function subscribeOne(args: {
    source: CoachSurfaceSourceDeps;
    handler: ReturnType<typeof createSpaceCoachSurfaceTopicHandler>;
    subscriptionId?: string;
    userId?: string;
  }) {
    const spy = makeEmitSpy();
    const ctx = makeCtx({
      topic: { kind: 'space.coach_surface', spaceId: SPACE_ID },
      emit: spy.emit,
      ...(args.subscriptionId !== undefined ? { subscriptionId: args.subscriptionId } : {}),
      ...(args.userId !== undefined ? { userId: args.userId } : {}),
    });
    const result = await args.handler.subscribe(ctx);
    if (result.kind !== 'accepted') throw new Error('expected accepted');
    return { result, ...spy };
  }

  it('rebuilds for an entity event that lands while the boot snapshot is building', async () => {
    const { redis } = makeRedisStub();
    const source = makeSource(makeSnapshot());
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });

    const gate = source.gateNextBuild();
    const { result, emitted } = await subscribeOne({ source, handler });
    const started = result.start?.();
    await gate.entered;

    // The window a read-before-subscribe boot cannot see: the write is durable
    // and its wake fires while the first snapshot is still being assembled.
    source.setNext(makeSnapshot({ coach: { ...baseCoach, lifecycle: 'reviewing' } }));
    await emitEntityEvent('entity.coach.activated');
    gate.release();
    await started;
    await converge();

    expect(observedLifecycle(emitted)).toBe('reviewing');
    await result.cleanup();
  });

  it('does not drop a wake that arrives during an in-flight rebuild', async () => {
    const { redis } = makeRedisStub();
    const source = makeSource(makeSnapshot());
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });

    const { result, emitted } = await subscribeOne({ source, handler });
    await result.start?.();
    await converge();

    const gate = source.gateNextBuild();
    await emitEntityEvent('entity.coach.activated');
    await gate.entered;

    source.setNext(makeSnapshot({ coach: { ...baseCoach, lifecycle: 'reviewing' } }));
    await emitEntityEvent('entity.coach.proposal');
    gate.release();
    await converge();

    expect(observedLifecycle(emitted)).toBe('reviewing');
    await result.cleanup();
  });

  it('rebuilds when the pub/sub connection reconnects after a missed wake', async () => {
    const { redis } = makeRedisStub();
    const source = makeSource(makeSnapshot());
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });

    const { result, emitted } = await subscribeOne({ source, handler });
    await result.start?.();
    await converge();

    bus.setPublishDelivery(false);
    source.setNext(makeSnapshot({ coach: { ...baseCoach, lifecycle: 'reviewing' } }));
    await emitEntityEvent('entity.coach.activated');
    bus.setPublishDelivery(true);

    const subscriber = bus.subscribers[0];
    if (!subscriber) throw new Error('expected a subscriber connection');
    subscriber.emitReady();
    await converge();

    expect(observedLifecycle(emitted)).toBe('reviewing');
    await result.cleanup();
  });

  it('rebuilds on a run transition, which no coach-specific event announces', async () => {
    const { redis } = makeRedisStub();
    const source = makeSource(makeSnapshot());
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });

    const { result, emitted } = await subscribeOne({ source, handler });
    await result.start?.();
    await converge();

    source.setNext(makeSnapshot({ surfacedRuns: [baseRun] }));
    await emitEntityEvent('entity.run.updated');
    await converge();

    const runsDelta = emitted
      .filter((m): m is Extract<ServerRealtimeMessage, { type: 'event' }> => m.type === 'event')
      .find((m) => (m.event as { kind?: string }).kind === 'surfaced_runs');
    expect(runsDelta).toBeDefined();
    await result.cleanup();
  });

  it('rebuilds at the snapshot-declared time-derived change, with no event', async () => {
    const { redis } = makeRedisStub();
    const source = makeSource(makeSnapshot());
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });

    const deadlineAt = Date.now() + 120_000;
    source.setDeadline(deadlineAt);

    const { result, emitted } = await subscribeOne({ source, handler });
    await result.start?.();
    await converge();
    expect(lifecycleDeltas(emitted)).toHaveLength(0);

    // The window closes on its own — no producer can announce this.
    source.setNext(makeSnapshot({ coach: { ...baseCoach, lifecycle: 'stalled' } }));
    await vi.advanceTimersByTimeAsync(130_000);

    expect(observedLifecycle(emitted)).toBe('stalled');
    await result.cleanup();
  });

  it('converges a subscriber that joins a warm pool entry after a missed wake', async () => {
    const { redis } = makeRedisStub();
    const source = makeSource(makeSnapshot());
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });

    const first = await subscribeOne({ source, handler, subscriptionId: 'sub-a' });
    await first.result.start?.();
    await converge();

    bus.setPublishDelivery(false);
    source.setNext(makeSnapshot({ coach: { ...baseCoach, lifecycle: 'reviewing' } }));
    await emitEntityEvent('entity.coach.activated');
    bus.setPublishDelivery(true);

    const second = await subscribeOne({ source, handler, subscriptionId: 'sub-b' });
    await second.result.start?.();
    await converge();

    expect(observedLifecycle(second.emitted)).toBe('reviewing');
    await Promise.all([first.result.cleanup(), second.result.cleanup()]);
  });

  it('stops rebuilding once nothing is happening and nothing is on a clock', async () => {
    const { redis } = makeRedisStub();
    const source = makeSource(makeSnapshot());
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });

    const { result } = await subscribeOne({ source, handler });
    await result.start?.();
    await converge();

    const buildsAfterBoot = source.buildCalls();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(source.buildCalls()).toBe(buildsAfterBoot);
    await result.cleanup();
  });

  it('shares one pool entry across two users watching the same space', async () => {
    const { redis } = makeRedisStub();
    const source = makeSource(makeSnapshot());
    const handler = createSpaceCoachSurfaceTopicHandler({ db: fakeDb, redis, source });

    const [a, b] = await Promise.all([
      subscribeOne({ source, handler, subscriptionId: 'sub-a', userId: 'user-a' }),
      subscribeOne({ source, handler, subscriptionId: 'sub-b', userId: 'user-b' }),
    ]);
    await Promise.all([a.result.start?.(), b.result.start?.()]);
    await converge();

    expect(source.buildCalls()).toBe(1);
    expect(bus.subscribers).toHaveLength(1);

    source.setNext(makeSnapshot({ coach: { ...baseCoach, lifecycle: 'reviewing' } }));
    await emitEntityEvent('entity.coach.activated');
    await converge();

    expect(observedLifecycle(a.emitted)).toBe('reviewing');
    expect(observedLifecycle(b.emitted)).toBe('reviewing');
    await Promise.all([a.result.cleanup(), b.result.cleanup()]);
  });
});
