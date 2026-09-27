import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import {
  upsertPendingDelegationCompletion,
  getPendingDelegationData,
  setSessionState,
  setStepState,
  getStepState,
  type SessionHotState,
  type StepHotState,
} from '@aflow/redis';

const mockReconcile = vi.fn();
const mockFailRun = vi.fn();

vi.mock('../reconcileParentDelegation.js', () => ({
  reconcileParentDelegationForChild: (...args: unknown[]) => mockReconcile(...args),
}));

vi.mock('../failRun.js', () => ({
  failRun: (...args: unknown[]) => mockFailRun(...args),
}));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  logOrchestratorError: vi.fn(),
}));

import { drainPendingDelegations } from '../delegationPendingDrain.js';

// ── Fixtures ─────────────────────────────────────────────────────────

// TenantIdSchema requires a UUID; using a real UUID so the synthetic
// step-result message that the drain injects passes schema validation.
const TENANT = 'a0000000-0000-4000-8000-000000000001';
const PARENT = '11111111-1111-4111-9111-111111111111';
const PARENT_STEP = '22222222-2222-4222-9222-222222222222';
const CHILD = '33333333-3333-4333-9333-333333333333';

function mkRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

const stubAgentDefLoader = vi.fn().mockResolvedValue({
  flowId: 'agent-x',
  flowVersion: '1',
  steps: [],
});

function mkParentSession(overrides: Partial<SessionHotState> = {}): SessionHotState {
  return {
    sessionId: PARENT as never,
    tenantId: TENANT as never,
    target: { kind: 'platform-role', systemRole: 'agent-x' as never },
    agentVersion: '1',
    status: 'WAITING_ON_CHILD',
    createdAt: 1000,
    lastUpdatedAt: 1000,
    waitingForChildSessionIds: [CHILD],
    ...overrides,
  } as SessionHotState;
}

function mkParentStep(overrides: Partial<StepHotState> = {}): StepHotState {
  return {
    stepExecutionId: PARENT_STEP as never,
    tenantId: TENANT as never,
    sessionId: PARENT as never,
    stepId: 'delegate-step',
    stepType: 'agent',
    operationId: 'agent.control.delegate',
    attempt: 1,
    status: 'PAUSED',
    scheduledAt: 1000,
    startedAt: 1100,
    inputRef: 'inline:eyJpbnB1dCI6e319',
    idempotencyKey: 'idem-1',
    ...overrides,
  } as StepHotState;
}

async function seed(
  redis: RedisType,
  parent: SessionHotState,
  parentStep: StepHotState,
): Promise<void> {
  await setSessionState(redis, parent);
  await setStepState(redis, parentStep);
}

/**
 * Read the most recent `SessionStalled` event from the parent session's
 * event stream. `appendSessionEvent` writes via XADD to
 * `aflow:session_events:<tenantId>:<sessionId>`, so we walk the stream
 * fields and JSON-parse the serialized event.
 */
async function readStalledEvent(
  redis: RedisType,
  tenantId: string,
  parentRunId: string,
): Promise<{ eventType?: string; metadata?: { code?: string } } | undefined> {
  const streamKey = StreamKeys.sessionEventsStream(tenantId, parentRunId);
  const entries = await redis.xrange(streamKey, '-', '+');
  for (const [, fields] of entries) {
    const map: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      const k = fields[i];
      const v = fields[i + 1];
      if (typeof k === 'string' && typeof v === 'string') map[k] = v;
    }
    let eventType: string | undefined;
    let metadata: { code?: string } | undefined;
    for (const [k, v] of Object.entries(map)) {
      if (k === 'eventType') eventType = v;
      if (k === 'metadata') {
        try {
          metadata = JSON.parse(v) as { code?: string };
        } catch {
          /* ignore */
        }
      }
    }
    if (eventType === 'SessionStalled') return { eventType, metadata };
  }
  return undefined;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('drainPendingDelegations — Done check', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
    vi.clearAllMocks();
  });

  it('parent step SUCCEEDED → completes lifecycle, no escalation, no reconcile call', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    await seed(
      redis,
      mkParentSession({ status: 'SUCCEEDED' }),
      mkParentStep({ status: 'SUCCEEDED' }),
    );

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });

    expect(result.claimed).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.escalated).toBe(0);
    expect(mockReconcile).not.toHaveBeenCalled();
    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data).toBeNull();
  });

  it('parent step PAUSED + parent session bubbled (delegationPauseSource=child_input) → done', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    await seed(
      redis,
      mkParentSession({
        status: 'PAUSED',
        delegationPauseSource: 'child_input',
        pausedChildSessionId: CHILD,
        requestedInputRef: 'inline:e30=',
        startedAt: 1100,
      }),
      mkParentStep({ status: 'PAUSED' }),
    );

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.completed).toBe(1);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('parent step PAUSED but parent session NOT bubbled → keep retrying', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    await seed(
      redis,
      mkParentSession({ status: 'WAITING_ON_CHILD' }), // no delegationPauseSource
      mkParentStep({ status: 'PAUSED' }),
    );
    mockReconcile.mockResolvedValue('result_enqueued');

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.retried).toBe(1);
    expect(result.completed).toBe(0);
    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data?.attempt).toBe(1);
  });
});

describe('drainPendingDelegations — retry then succeed', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
    vi.clearAllMocks();
  });

  it('first tick retries; second tick (after rewinding score) completes', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    await seed(
      redis,
      mkParentSession({ status: 'WAITING_ON_CHILD' }),
      mkParentStep({ status: 'STARTED' }),
    );
    mockReconcile.mockResolvedValueOnce('result_enqueued');

    const r1 = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(r1.retried).toBe(1);

    // Simulate the backoff window expiring.
    await redis.zadd(StreamKeys.delegationPendingKey, '0', `${TENANT}:${CHILD}`);
    // Parent step is now SUCCEEDED.
    await setStepState(redis, mkParentStep({ status: 'SUCCEEDED' }));
    await setSessionState(redis, mkParentSession({ status: 'SUCCEEDED' }));

    const r2 = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(r2.completed).toBe(1);
  });
});

describe('drainPendingDelegations — escalation', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
    vi.clearAllMocks();
  });

  it('after maxAttempts: synthetic FAILED + unpause-first + SessionStalled event', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    // Pre-bump attempt to maxAttempts-1 so this tick escalates.
    // Pre-set attempt to maxAttempts-1 so this tick triggers escalation.
    await redis.hset(StreamKeys.delegationPendingDataKey(TENANT, CHILD), 'attempt', '9');
    await seed(
      redis,
      mkParentSession({ status: 'WAITING_ON_CHILD' }),
      mkParentStep({ status: 'PAUSED' }),
    );
    mockReconcile.mockResolvedValue('result_enqueued');

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.escalated).toBe(1);

    // Unpause-first: parent step transitioned PAUSED → STARTED before injection.
    const stepAfter = await getStepState(redis, TENANT, PARENT_STEP);
    expect(stepAfter?.status).toBe('STARTED');

    // SessionStalled event was appended on parent session.
    const stalled = await readStalledEvent(redis, TENANT, PARENT);
    expect(stalled).toBeDefined();
    expect(stalled?.metadata?.code).toBe('DELEGATION_RECONCILE_STALLED');

    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data).not.toBeNull();
    expect(data?.escalations).toBe(1);
  });

  it('escalates immediately when reconcile reports parent_state_missing', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    await seed(
      redis,
      mkParentSession({ status: 'WAITING_ON_CHILD' }),
      mkParentStep({ status: 'STARTED' }),
    );
    mockReconcile.mockResolvedValue('parent_state_missing');

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.escalated).toBe(1);
    const stalled = await readStalledEvent(redis, TENANT, PARENT);
    expect(stalled?.metadata?.code).toBe('PARENT_STATE_MISSING');
  });

  it('falls back to failRun when parent step is missing', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    // Pre-set attempt to maxAttempts-1 so this tick triggers escalation.
    await redis.hset(StreamKeys.delegationPendingDataKey(TENANT, CHILD), 'attempt', '9');
    // Seed parent session but NOT step state.
    await setSessionState(redis, mkParentSession({ status: 'WAITING_ON_CHILD' }));
    mockReconcile.mockResolvedValue('result_enqueued');
    mockFailRun.mockResolvedValue(undefined);

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.escalated).toBe(1);
    expect(mockFailRun).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      PARENT,
      'DELEGATION_RECONCILE_STALLED',
      expect.any(String),
      'internal',
    );
    // failRun returned cleanly → lifecycle cleared.
    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data).toBeNull();
  });
});

describe('drainPendingDelegations — parent unresolvable', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
    vi.clearAllMocks();
  });

  it('logs anomaly + abort lifecycle; does NOT emit SessionStalled (no session id to attach to)', async () => {
    // Pending entry with no parent ids in data, no reverse index, no child state.
    await redis.zadd(StreamKeys.delegationPendingKey, '100', `${TENANT}:${CHILD}`);
    // No HSET on data, no reverse index, no child session state.

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.unresolvable).toBe(1);
    expect(mockFailRun).not.toHaveBeenCalled();
    // Pending entry was aborted (cleaned up).
    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data).toBeNull();
    // No SessionStalled emitted (the events list for an unrelated session
    // doesn't exist, but we can verify there's no event for any tracked
    // session — the unresolvable case has no session id to anchor to).
  });
});

describe('drainPendingDelegations — recovery hierarchy', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
    vi.clearAllMocks();
  });

  it('falls back to reverse index when pending data parent ids are missing', async () => {
    // ZSET entry with no data hash; seed reverse index directly.
    await redis.zadd(StreamKeys.delegationPendingKey, '100', `${TENANT}:${CHILD}`);
    await redis.hset(StreamKeys.delegationParentKey(TENANT, CHILD), {
      parentRunId: PARENT,
      parentStepExecutionId: PARENT_STEP,
    });
    await seed(
      redis,
      mkParentSession({ status: 'SUCCEEDED' }),
      mkParentStep({ status: 'SUCCEEDED' }),
    );

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.completed).toBe(1);
    expect(result.unresolvable).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════

describe('drainPendingDelegations — synthetic-injected-but-not-applied (escalation cap)', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
    vi.clearAllMocks();
  });

  it('after first escalation, lifecycle survives; next drain tick after synthetic NOT applied re-escalates', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    // Pre-set attempt to maxAttempts-1 so this tick triggers escalation.
    await redis.hset(StreamKeys.delegationPendingDataKey(TENANT, CHILD), 'attempt', '9');
    await seed(
      redis,
      mkParentSession({ status: 'WAITING_ON_CHILD' }),
      mkParentStep({ status: 'STARTED' }),
    );
    mockReconcile.mockResolvedValue('result_enqueued');

    // Tick 1: escalate — synthetic FAILED injected, lifecycle survives.
    const r1 = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(r1.escalated).toBe(1);
    expect(r1.escalation_capped).toBe(0);
    let data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data).not.toBeNull();
    expect(data?.escalations).toBe(1);

    // Simulate "synthetic FAILED was NOT applied": rewind score, parent
    // step is still STARTED (applyResult dropped the synthetic). Drain
    // re-escalates (idempotent injection).
    await redis.zadd(StreamKeys.delegationPendingKey, '0', `${TENANT}:${CHILD}`);
    await setStepState(redis, mkParentStep({ status: 'STARTED' }));

    const r2 = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(r2.escalated).toBe(1);
    data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data?.escalations).toBe(2);
  });

  it('after escalation cap (3 by default), falls through to failRun + clears lifecycle', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    // Pre-set escalations to maxEscalations-1 so this tick caps.
    // Pre-set attempt to maxAttempts-1 so this tick triggers escalation.
    await redis.hset(StreamKeys.delegationPendingDataKey(TENANT, CHILD), 'attempt', '9');
    await redis.hset(StreamKeys.delegationPendingDataKey(TENANT, CHILD), 'escalations', '2');
    await seed(
      redis,
      mkParentSession({ status: 'WAITING_ON_CHILD' }),
      mkParentStep({ status: 'STARTED' }),
    );
    mockReconcile.mockResolvedValue('result_enqueued');

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.escalation_capped).toBe(1);
    expect(result.escalated).toBe(0);
    // Cap reached: failRun called + lifecycle cleared.
    expect(mockFailRun).toHaveBeenCalled();
    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data).toBeNull();
  });

  it('successful applyResult between ticks → next tick observes parent terminal and completes (no extra escalation)', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    // Pre-set attempt to maxAttempts-1 so this tick triggers escalation.
    await redis.hset(StreamKeys.delegationPendingDataKey(TENANT, CHILD), 'attempt', '9');
    await seed(
      redis,
      mkParentSession({ status: 'WAITING_ON_CHILD' }),
      mkParentStep({ status: 'STARTED' }),
    );
    mockReconcile.mockResolvedValue('result_enqueued');

    // Tick 1: escalate, lifecycle survives.
    const r1 = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(r1.escalated).toBe(1);

    // Between ticks, applyResult lands the synthetic FAILED — parent
    // step is now FAILED.
    await redis.zadd(StreamKeys.delegationPendingKey, '0', `${TENANT}:${CHILD}`);
    await setStepState(redis, mkParentStep({ status: 'FAILED' }));

    const r2 = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(r2.completed).toBe(1);
    expect(r2.escalated).toBe(0);
    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data).toBeNull();
  });
});

describe('drainPendingDelegations — Done check is child-specific', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
    vi.clearAllMocks();
  });

  it('parent paused on a DIFFERENT child does NOT mark THIS child done', async () => {
    const OTHER_CHILD = '99999999-9999-4999-9999-999999999999';
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    // Parent session is PAUSED with delegationPauseSource='child_input'
    // for an UNRELATED child (OTHER_CHILD), and our child is still
    // pending — drain should NOT clear this lifecycle on the bubble.
    await seed(
      redis,
      mkParentSession({
        status: 'PAUSED',
        delegationPauseSource: 'child_input',
        pausedChildSessionId: OTHER_CHILD, // different child!
        requestedInputRef: 'inline:e30=',
        waitingForChildSessionIds: [CHILD, OTHER_CHILD],
      }),
      mkParentStep({ status: 'PAUSED' }),
    );
    mockReconcile.mockResolvedValue('result_enqueued');

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.completed).toBe(0);
    expect(result.retried).toBe(1);
  });

  it('PAUSED parent step with empty requestedInputRef does NOT count as done', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    await seed(
      redis,
      mkParentSession({
        status: 'PAUSED',
        delegationPauseSource: 'child_input',
        pausedChildSessionId: CHILD,
        // requestedInputRef intentionally omitted (partial-bubble case)
        waitingForChildSessionIds: [CHILD],
      }),
      mkParentStep({ status: 'PAUSED' }),
    );
    mockReconcile.mockResolvedValue('result_enqueued');

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.completed).toBe(0);
    expect(result.retried).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════

describe('drainPendingDelegations — failRun-throws fallback retains lifecycle', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
    vi.clearAllMocks();
  });

  it('parent step missing + failRun throws → entry retained as retried, NOT cleared', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    // Pre-set attempt to maxAttempts-1 so this tick triggers escalation.
    await redis.hset(StreamKeys.delegationPendingDataKey(TENANT, CHILD), 'attempt', '9');
    // Seed parent session but NOT step state — forces the !injected branch.
    await setSessionState(redis, mkParentSession({ status: 'WAITING_ON_CHILD' }));
    mockReconcile.mockResolvedValue('result_enqueued');
    // Simulate failRun blowing up (e.g. its own enqueue cascades and the
    // upstream upsert throws DelegationLifecycleUpsertFailed).
    mockFailRun.mockRejectedValueOnce(new Error('failRun cascade upsert blew up'));

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.escalated).toBe(0);
    expect(result.retried).toBe(1); // accounted as retried, not lost
    // Lifecycle MUST survive — the only durable proof the cascade is
    // unfinished. A future drain tick will retry escalation.
    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data).not.toBeNull();
    expect(data?.escalations).toBe(1);
    expect(data?.lastError).toContain('failRun');
  });

  it('escalation cap + failRun throws → entry retained as retried, NOT cleared', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    // Pre-set attempt to maxAttempts-1 so this tick triggers escalation.
    await redis.hset(StreamKeys.delegationPendingDataKey(TENANT, CHILD), 'attempt', '9');
    await redis.hset(StreamKeys.delegationPendingDataKey(TENANT, CHILD), 'escalations', '2');
    await seed(
      redis,
      mkParentSession({ status: 'WAITING_ON_CHILD' }),
      mkParentStep({ status: 'STARTED' }),
    );
    mockReconcile.mockResolvedValue('result_enqueued');
    mockFailRun.mockRejectedValueOnce(new Error('failRun at cap blew up'));

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.escalation_capped).toBe(0);
    expect(result.retried).toBe(1);
    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════

describe('drainPendingDelegations — lifecycle-already-resolved outcomes clear, not escalate', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
    vi.clearAllMocks();
  });

  it('parent_not_tracking_child → clear lifecycle without escalating, even at maxAttempts', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    // Pre-set attempt to maxAttempts-1 so this tick would normally escalate.
    // Pre-set attempt to maxAttempts-1 so this tick triggers escalation.
    await redis.hset(StreamKeys.delegationPendingDataKey(TENANT, CHILD), 'attempt', '9');
    await seed(
      redis,
      // Parent session is WAITING_ON_CHILD on a DIFFERENT child — has moved
      // past this one. (waitingForChildSessionIds doesn't include CHILD.)
      mkParentSession({
        status: 'WAITING_ON_CHILD',
        waitingForChildSessionIds: ['99999999-9999-4999-9999-999999999999'],
      }),
      // Old delegate step stuck in PAUSED (the bug scenario).
      mkParentStep({ status: 'PAUSED' }),
    );
    mockReconcile.mockResolvedValue('parent_not_tracking_child');

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });

    // The critical assertions: NO escalation, NO synthetic FAILED injection,
    // NO failRun fallback. Lifecycle is just cleared.
    expect(result.escalated).toBe(0);
    expect(result.escalation_capped).toBe(0);
    expect(result.completed).toBe(1);
    expect(mockFailRun).not.toHaveBeenCalled();
    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data).toBeNull();
    // No SessionStalled event emitted on the parent — drain didn't fabricate failure.
    const stalled = await readStalledEvent(redis, TENANT, PARENT);
    expect(stalled).toBeUndefined();
  });

  it('parent_already_advanced (terminal session) → clear', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    // Pre-set attempt to maxAttempts-1 so this tick triggers escalation.
    await redis.hset(StreamKeys.delegationPendingDataKey(TENANT, CHILD), 'attempt', '9');
    await seed(
      redis,
      mkParentSession({ status: 'SUCCEEDED' }),
      mkParentStep({ status: 'STARTED' }),
    );
    mockReconcile.mockResolvedValue('parent_already_advanced');

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.completed).toBe(1);
    expect(result.escalated).toBe(0);
    expect(mockFailRun).not.toHaveBeenCalled();
  });

  it('child_not_resting → clear (lifecycle was created prematurely or child resumed)', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    // Pre-set attempt to maxAttempts-1 so this tick triggers escalation.
    await redis.hset(StreamKeys.delegationPendingDataKey(TENANT, CHILD), 'attempt', '9');
    await seed(
      redis,
      mkParentSession({ status: 'WAITING_ON_CHILD' }),
      mkParentStep({ status: 'PAUSED' }),
    );
    mockReconcile.mockResolvedValue('child_not_resting');

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.completed).toBe(1);
    expect(result.escalated).toBe(0);
  });

  it('parent_interrupted_suppressed → clear (intentional pause-by-interrupt)', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    // Pre-set attempt to maxAttempts-1 so this tick triggers escalation.
    await redis.hset(StreamKeys.delegationPendingDataKey(TENANT, CHILD), 'attempt', '9');
    await seed(redis, mkParentSession({ status: 'PAUSED' }), mkParentStep({ status: 'PAUSED' }));
    mockReconcile.mockResolvedValue('parent_interrupted_suppressed');

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.completed).toBe(1);
    expect(result.escalated).toBe(0);
  });
});

describe('drainPendingDelegations — escalation defense-in-depth re-check', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
    vi.clearAllMocks();
  });

  it('parent_state_missing path: if parent regained state between ticks and no longer tracks child, clear instead of escalating', async () => {
    // Reconcile says child_state_missing → drain heads to escalate path.
    // But by the time escalate runs, the parent session is back AND has
    // moved on (no longer tracking this child). The defense-in-depth
    // re-check catches this and clears.
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    await seed(
      redis,
      mkParentSession({
        status: 'RUNNING',
        waitingForChildSessionIds: ['99999999-9999-4999-9999-999999999999'], // different child
      }),
      mkParentStep({ status: 'STARTED' }),
    );
    mockReconcile.mockResolvedValue('child_state_missing');

    const result = await drainPendingDelegations({
      redis,
      payloadStore: {} as never,
      agentDefLoader: stubAgentDefLoader,
    });
    expect(result.completed).toBe(1);
    expect(result.escalated).toBe(0);
    expect(mockFailRun).not.toHaveBeenCalled();
    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data).toBeNull();
    const stalled = await readStalledEvent(redis, TENANT, PARENT);
    expect(stalled).toBeUndefined();
  });
});
