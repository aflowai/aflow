import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionHotState, StepHotState } from '@aflow/redis';
import type { RecoveryEventEnvelope, RunSnapshot } from '@aflow/schemas';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSetRunState = vi.fn().mockResolvedValue(undefined);
const mockSetStepState = vi.fn().mockResolvedValue(undefined);
const mockReadRecoveryEvents = vi.fn().mockResolvedValue([]);
const mockGetRunStateSafe = vi.fn().mockResolvedValue({ ok: false, kind: 'missing' });

vi.mock('@aflow/redis', () => ({
  SessionHotStateSchema: {
    safeParse: (data: unknown) => {
      if (data && typeof data === 'object' && 'sessionId' in data) {
        return { success: true, data };
      }
      return { success: false, error: { message: 'invalid' } };
    },
  },
  StepHotStateSchema: {
    safeParse: (data: unknown) => {
      if (data && typeof data === 'object' && 'stepExecutionId' in data) {
        return { success: true, data };
      }
      return { success: false, error: { message: 'invalid' } };
    },
  },
  setSessionState: (...args: unknown[]) => mockSetRunState(...args),
  setStepState: (...args: unknown[]) => mockSetStepState(...args),
  readRecoveryEvents: (...args: unknown[]) => mockReadRecoveryEvents(...args),
  getSessionStateSafe: (...args: unknown[]) => mockGetRunStateSafe(...args),
}));

import { recoverShardRuns, type RecoverShardRunsDeps } from '../RecoveryService.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TENANT = 'test-tenant';
const RUN_1 = '00000000-0000-0000-0000-000000000001';
const RUN_2 = '00000000-0000-0000-0000-000000000002';
const STEP_1 = '00000000-0000-0000-0000-000000000010';

function makeSessionHotState(
  runId: string,
  overrides: Partial<SessionHotState> = {},
): SessionHotState {
  return {
    sessionId: runId,
    tenantId: TENANT,
    agentId: 'test-flow',
    agentVersion: '1',
    status: 'RUNNING',
    createdAt: 1000,
    lastUpdatedAt: 1000,
    ...overrides,
  };
}

function makeStepHotState(overrides: Partial<StepHotState> = {}): StepHotState {
  return {
    stepExecutionId: STEP_1,
    tenantId: TENANT,
    sessionId: RUN_1,
    stepId: 'step-1',
    stepType: 'ai',
    operationId: 'ai.text.generate',
    attempt: 1,
    status: 'SCHEDULED',
    scheduledAt: 1000,
    inputRef: 'inline:test',
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

function makeSnapshot(runId: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  const runHotState = makeSessionHotState(runId) as unknown as Record<string, unknown>;
  return {
    version: 1,
    tenantId: TENANT,
    sessionId: runId,
    seq: 50,
    timestamp: Date.now(),
    sessionHotState: runHotState,
    stepHotStates: {},
    checksum: 'test-checksum',
    ...overrides,
  };
}

function makeEvent(
  seq: number,
  type: RecoveryEventEnvelope['type'],
  data: Record<string, unknown>,
  stepExecutionId?: string,
): RecoveryEventEnvelope {
  return {
    version: 1,
    type,
    tenantId: TENANT,
    runId: RUN_1,
    seq,
    timestamp: 1000 + seq,
    ...(stepExecutionId !== undefined ? { stepExecutionId } : {}),
    data,
  };
}

interface FakeManifestRow {
  runId: string;
  tenantId: string;
  shardId: number;
  status: string;
  lastRecoverySeq: number;
  latestSnapshotRef: string | null;
  latestSnapshotSeq: number | null;
  updatedAt: Date;
}

function makeManifestRow(runId: string, overrides: Partial<FakeManifestRow> = {}): FakeManifestRow {
  return {
    runId,
    tenantId: TENANT,
    shardId: 0,
    status: 'RUNNING',
    lastRecoverySeq: 0,
    latestSnapshotRef: null,
    latestSnapshotSeq: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<RecoverShardRunsDeps> = {}): RecoverShardRunsDeps {
  return {
    redis: {} as RecoverShardRunsDeps['redis'],
    manifestRepo: {
      getByShards: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      updateSeq: vi.fn(),
      updateSnapshot: vi.fn(),
      remove: vi.fn(),
      removeBatch: vi.fn(),
      getBySessionId: vi.fn(),
    },
    snapshotService: {
      maybeSnapshot: vi.fn(),
      forceSnapshot: vi.fn(),
      loadSnapshot: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('recoverShardRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns zeros for empty shard list', async () => {
    const deps = makeDeps();
    const result = await recoverShardRuns(deps, []);

    expect(result.recovered).toBe(0);
    expect(result.quarantined).toBe(0);
    expect(deps.manifestRepo.getByShards).not.toHaveBeenCalled();
  });

  it('returns zeros when manifest has no runs for shards', async () => {
    const deps = makeDeps();
    const result = await recoverShardRuns(deps, [0, 1, 2]);

    expect(result.recovered).toBe(0);
    expect(result.quarantined).toBe(0);
    expect(deps.manifestRepo.getByShards).toHaveBeenCalledWith([0, 1, 2]);
  });

  it('recovers a run with snapshot + tail replay', async () => {
    const snapshot = makeSnapshot(RUN_1);
    const tailEvent = makeEvent(51, 'run.status_changed', {
      fromStatus: 'RUNNING',
      toStatus: 'PAUSED',
    });

    const deps = makeDeps();
    vi.mocked(deps.manifestRepo.getByShards).mockResolvedValue([makeManifestRow(RUN_1)]);
    vi.mocked(deps.snapshotService.loadSnapshot).mockResolvedValue(snapshot);
    mockReadRecoveryEvents.mockResolvedValue([tailEvent]);

    const result = await recoverShardRuns(deps, [0]);

    expect(result.recovered).toBe(1);
    expect(result.quarantined).toBe(0);
    expect(deps.snapshotService.loadSnapshot).toHaveBeenCalledWith(TENANT, RUN_1);
    expect(mockSetRunState).toHaveBeenCalled();
  });

  it('recovers a run without snapshot (genesis replay)', async () => {
    const runHotState = makeSessionHotState(RUN_1);
    const stepHotState = makeStepHotState();

    const events: RecoveryEventEnvelope[] = [
      makeEvent(1, 'run.created', { runHotState, stepHotState }),
      makeEvent(2, 'step.claimed', {}, STEP_1),
    ];

    const deps = makeDeps();
    vi.mocked(deps.manifestRepo.getByShards).mockResolvedValue([makeManifestRow(RUN_1)]);
    vi.mocked(deps.snapshotService.loadSnapshot).mockResolvedValue(null);
    mockReadRecoveryEvents.mockResolvedValue(events);

    const result = await recoverShardRuns(deps, [0]);

    expect(result.recovered).toBe(1);
    expect(result.quarantined).toBe(0);
  });

  it('quarantines a run with no snapshot and no events', async () => {
    const deps = makeDeps();
    vi.mocked(deps.manifestRepo.getByShards).mockResolvedValue([makeManifestRow(RUN_1)]);
    vi.mocked(deps.snapshotService.loadSnapshot).mockResolvedValue(null);
    mockReadRecoveryEvents.mockResolvedValue([]);

    const result = await recoverShardRuns(deps, [0]);

    expect(result.recovered).toBe(0);
    expect(result.quarantined).toBe(1);
  });

  it('quarantines a run when recoverRun throws', async () => {
    const deps = makeDeps();
    vi.mocked(deps.manifestRepo.getByShards).mockResolvedValue([makeManifestRow(RUN_1)]);
    vi.mocked(deps.snapshotService.loadSnapshot).mockRejectedValue(new Error('Redis down'));

    const result = await recoverShardRuns(deps, [0]);

    expect(result.recovered).toBe(0);
    expect(result.quarantined).toBe(1);
  });

  it('recovers multiple runs across shards', async () => {
    const snap1 = makeSnapshot(RUN_1);
    const snap2 = makeSnapshot(RUN_2);

    const deps = makeDeps();
    vi.mocked(deps.manifestRepo.getByShards).mockResolvedValue([
      makeManifestRow(RUN_1, { shardId: 0 }),
      makeManifestRow(RUN_2, { shardId: 1 }),
    ]);

    vi.mocked(deps.snapshotService.loadSnapshot).mockImplementation(async (_t, runId) => {
      if (runId === RUN_1) return snap1;
      if (runId === RUN_2) return snap2;
      return null;
    });

    // Both runs have no tail events after snapshot
    mockReadRecoveryEvents.mockResolvedValue([]);

    // But recoverRun needs events after snapshot seq — with empty events and a snapshot,
    // it will still succeed (snapshot provides full state, no tail to replay)
    const result = await recoverShardRuns(deps, [0, 1]);

    expect(result.recovered).toBe(2);
    expect(result.quarantined).toBe(0);
  });

  it('handles mix of recovered and quarantined runs', async () => {
    const snap1 = makeSnapshot(RUN_1);

    const deps = makeDeps();
    vi.mocked(deps.manifestRepo.getByShards).mockResolvedValue([
      makeManifestRow(RUN_1, { shardId: 0 }),
      makeManifestRow(RUN_2, { shardId: 0 }),
    ]);

    // RUN_1 has snapshot, RUN_2 has nothing
    vi.mocked(deps.snapshotService.loadSnapshot).mockImplementation(async (_t, runId) => {
      if (runId === RUN_1) return snap1;
      return null;
    });
    mockReadRecoveryEvents.mockResolvedValue([]);

    const result = await recoverShardRuns(deps, [0]);

    expect(result.recovered).toBe(1);
    expect(result.quarantined).toBe(1);
  });

  it('returns elapsed time', async () => {
    const deps = makeDeps();
    const result = await recoverShardRuns(deps, [0]);

    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.elapsedMs).toBe('number');
  });
});
