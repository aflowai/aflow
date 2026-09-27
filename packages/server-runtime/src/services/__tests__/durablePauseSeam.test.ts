/**
 * A run that pauses for longer than the Redis TTL must still be resumable.
 *
 * Long-lived skill work does not sit hot: sessions reach a resting state
 * (PAUSED / WAITING_ON_CHILD) and flush, and what survives is the Postgres
 * `hot_state_snapshot`. This pins the read side of that seam. If the snapshot ever stops being
 * written, or its shape drifts from what rehydration parses, long-paused runs
 * become unresumable and this test fails first.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';

const mockGetById = vi.fn();
const mockSetSessionState = vi.fn();
const mockSetStepStateIfAbsent = vi.fn();

vi.mock('@aflow/database', () => ({
  createTenantContext: (tenantId: string) => ({ tenantId }),
  createSessionRepository: () => ({ getById: (id: string) => mockGetById(id) }),
  withTenantSchema: vi.fn(),
  idempotencyKeys: {},
}));

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aflow/redis');
  return {
    ...actual,
    setSessionState: (...args: unknown[]) => mockSetSessionState(...args),
    setStepStateIfAbsent: (...args: unknown[]) => mockSetStepStateIfAbsent(...args),
  };
});

const { rehydratePausedRun } = await import('../sessions.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const RUN = '00000000-0000-4000-8000-0000000000aa';
const STEP_EXEC = '00000000-0000-4000-8000-0000000000bb';

/** The hot state a paused run carries — what the flush worker snapshots. */
function pausedHotState() {
  return {
    sessionId: RUN,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' },
    agentVersion: '1',
    status: 'PAUSED',
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    lastUpdatedAt: 1_700_000_000_000,
    currentStepExecutionId: STEP_EXEC,
    currentStepId: 'await-approval',
  };
}

function stepHotState() {
  return {
    stepExecutionId: STEP_EXEC,
    sessionId: RUN,
    tenantId: TENANT,
    stepId: 'await-approval',
    stepType: 'user',
    operationId: 'user.interaction.approve',
    status: 'PAUSED',
    attempt: 1,
    scheduledAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    inputRef: 'inline:e30=',
    idempotencyKey: 'idem-step-1',
  };
}

/** Exactly the envelope the projection worker persists for a resting run. */
function snapshotFor(status: 'PAUSED' | 'WAITING_ON_CHILD') {
  return {
    runHotState: { ...pausedHotState(), status },
    stepHotStates: { [STEP_EXEC]: stepHotState() },
  };
}

const redis = {} as Redis;
const db = {} as PostgresJsDatabase;

describe('durable-pause seam — rehydrating an expired paused run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores run and step state from the Postgres snapshot', async () => {
    mockGetById.mockResolvedValue({
      status: 'PAUSED',
      hotStateSnapshot: snapshotFor('PAUSED'),
    });

    const state = await rehydratePausedRun(redis, db, TENANT, RUN);

    expect(state).not.toBeNull();
    expect(state?.status).toBe('PAUSED');
    expect(state?.currentStepExecutionId).toBe(STEP_EXEC);

    // Written back to Redis so the resume path finds a live run again.
    expect(mockSetSessionState).toHaveBeenCalledTimes(1);
    expect(mockSetSessionState.mock.calls[0]?.[1]).toMatchObject({ sessionId: RUN });
    // Create-if-absent, not write: a step that outlived the session hash is
    // newer than this snapshot and must not be rolled back onto it.
    expect(mockSetStepStateIfAbsent).toHaveBeenCalledTimes(1);
    expect(mockSetStepStateIfAbsent.mock.calls[0]?.[1]).toMatchObject({
      stepExecutionId: STEP_EXEC,
    });
  });

  it('rehydrates a run parked on a child sub-agent', async () => {
    mockGetById.mockResolvedValue({
      status: 'WAITING_ON_CHILD',
      hotStateSnapshot: snapshotFor('WAITING_ON_CHILD'),
    });

    const state = await rehydratePausedRun(redis, db, TENANT, RUN);

    expect(state?.status).toBe('WAITING_ON_CHILD');
    expect(mockSetSessionState).toHaveBeenCalledTimes(1);
  });

  it('returns null — never a half-written run — when no snapshot was persisted', async () => {
    mockGetById.mockResolvedValue({ status: 'PAUSED', hotStateSnapshot: null });

    expect(await rehydratePausedRun(redis, db, TENANT, RUN)).toBeNull();
    expect(mockSetSessionState).not.toHaveBeenCalled();
  });

  it('returns null for a run that is not resting', async () => {
    mockGetById.mockResolvedValue({ status: 'SUCCEEDED', hotStateSnapshot: snapshotFor('PAUSED') });

    expect(await rehydratePausedRun(redis, db, TENANT, RUN)).toBeNull();
    expect(mockSetSessionState).not.toHaveBeenCalled();
  });

  it('rejects a snapshot whose shape has drifted rather than restoring garbage', async () => {
    mockGetById.mockResolvedValue({
      status: 'PAUSED',
      hotStateSnapshot: { runHotState: { sessionId: RUN, status: 'PAUSED' } },
    });

    expect(await rehydratePausedRun(redis, db, TENANT, RUN)).toBeNull();
    expect(mockSetSessionState).not.toHaveBeenCalled();
  });
});
