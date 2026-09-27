import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetRunStateSafe = vi.fn();
const mockGetStepState = vi.fn();
const mockGetRecoveryEventCount = vi.fn();
const mockResetRecoveryEventCount = vi.fn();
const mockReadRecoveryEvents = vi.fn();

vi.mock('@aflow/redis', () => ({
  getSessionStateSafe: (...args: unknown[]) => mockGetRunStateSafe(...args),
  getStepState: (...args: unknown[]) => mockGetStepState(...args),
  getRecoveryEventCount: (...args: unknown[]) => mockGetRecoveryEventCount(...args),
  resetRecoveryEventCount: (...args: unknown[]) => mockResetRecoveryEventCount(...args),
  readRecoveryEvents: (...args: unknown[]) => mockReadRecoveryEvents(...args),
  HOT_STATE_TTL_SECONDS: 86400,
}));

vi.mock('@aflow/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/schemas')>();
  const { z } = await import('zod');

  const RunSnapshotSchema = z.object({
    version: z.literal(1),
    tenantId: z.string(),
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    timestamp: z.number(),
    sessionHotState: z.record(z.unknown()),
    stepHotStates: z.record(z.string(), z.record(z.unknown())),
    checksum: z.string(),
  });

  return {
    ...actual,
    RunSnapshotSchema,
    SnapshotTriggerConfigSchema: z.object({
      everyNEvents: z.number().int().min(1).default(50),
      maxInlineBytes: z.number().int().min(0).default(1_048_576),
    }),
    RecoveryStreamKeys: {
      recoverySeqKey: (tenantId: string, runId: string) =>
        `aflow:recovery_seq:${tenantId}:${runId}`,
      snapshotRefKey: (tenantId: string, runId: string) =>
        `aflow:snapshot:${tenantId}:${runId}:ref`,
      recoveryEventCountKey: (tenantId: string, runId: string) =>
        `aflow:recovery_count:${tenantId}:${runId}`,
    },
  };
});

import { createSnapshotService } from '../SnapshotService.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function canonicalStringify(obj: unknown): string {
  return JSON.stringify(obj, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

function computeExpectedChecksum(
  runHotState: Record<string, unknown>,
  stepHotStates: Record<string, Record<string, unknown>>,
): string {
  return createHash('sha256')
    .update(canonicalStringify({ runHotState, stepHotStates }))
    .digest('hex');
}

const SAMPLE_RUN_STATE = {
  sessionId: 'run-1',
  tenantId: 'tenant-1',
  agentId: 'flow-1',
  agentVersion: '1',
  status: 'RUNNING',
  createdAt: 1000,
  lastUpdatedAt: 2000,
  currentStepExecutionId: 'step-exec-1',
};

const SAMPLE_STEP_STATE = {
  stepExecutionId: 'step-exec-1',
  tenantId: 'tenant-1',
  sessionId: 'run-1',
  stepId: 'step-1',
  stepType: 'ai',
  operationId: 'ai.text.generate',
  attempt: 1,
  status: 'STARTED',
  scheduledAt: 1500,
  startedAt: 1600,
};

const SAMPLE_STEP_STATE_2 = {
  stepExecutionId: 'step-exec-2',
  tenantId: 'tenant-1',
  sessionId: 'run-1',
  stepId: 'step-2',
  stepType: 'api',
  operationId: 'api.http.call',
  attempt: 1,
  status: 'STARTED',
  scheduledAt: 1700,
  startedAt: 1800,
};

const SAMPLE_STEP_STATE_3 = {
  stepExecutionId: 'step-exec-3',
  tenantId: 'tenant-1',
  sessionId: 'run-1',
  stepId: 'step-3',
  stepType: 'ai',
  operationId: 'ai.text.generate',
  attempt: 1,
  status: 'SCHEDULED',
  scheduledAt: 1900,
};

// ── Fake Redis ────────────────────────────────────────────────────────────────

function createFakeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((...args: unknown[]) => {
      const key = args[0] as string;
      const value = args[1] as string;
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn((...keys: string[]) => {
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
      }
      return Promise.resolve(count);
    }),
    _store: store,
  } as unknown as import('ioredis').Redis;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SnapshotService', () => {
  let fakeRedis: ReturnType<typeof createFakeRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeRedis = createFakeRedis();

    // Default mocks
    mockGetRecoveryEventCount.mockResolvedValue(0);
    mockResetRecoveryEventCount.mockResolvedValue(undefined);
    mockGetRunStateSafe.mockResolvedValue({ ok: true, state: SAMPLE_RUN_STATE });
    mockGetStepState.mockImplementation((_redis: unknown, _tenant: string, stepExecId: string) => {
      if (stepExecId === 'step-exec-1') return Promise.resolve(SAMPLE_STEP_STATE);
      if (stepExecId === 'step-exec-2') return Promise.resolve(SAMPLE_STEP_STATE_2);
      if (stepExecId === 'step-exec-3') return Promise.resolve(SAMPLE_STEP_STATE_3);
      return Promise.resolve(null);
    });
    // Default: single scheduled step from recovery events
    mockReadRecoveryEvents.mockResolvedValue([
      {
        version: 1,
        type: 'step.scheduled',
        tenantId: 'tenant-1',
        runId: 'run-1',
        seq: 1,
        timestamp: 1000,
        stepExecutionId: 'step-exec-1',
        data: {},
      },
    ]);
  });

  // ── maybeSnapshot ─────────────────────────────────────────────────────

  it('does not snapshot when event count is below threshold', async () => {
    mockGetRecoveryEventCount.mockResolvedValue(10);

    const service = createSnapshotService({
      redis: fakeRedis,
      triggerConfig: { everyNEvents: 50 },
    });
    service.maybeSnapshot('tenant-1', 'run-1');

    await vi.waitFor(() => {
      expect(mockGetRecoveryEventCount).toHaveBeenCalledWith(fakeRedis, 'tenant-1', 'run-1');
    });

    expect(mockGetRunStateSafe).not.toHaveBeenCalled();
  });

  it('takes snapshot when event count reaches threshold', async () => {
    mockGetRecoveryEventCount.mockResolvedValue(50);
    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:recovery_seq:tenant-1:run-1',
      '75',
    );

    const service = createSnapshotService({
      redis: fakeRedis,
      triggerConfig: { everyNEvents: 50 },
    });
    service.maybeSnapshot('tenant-1', 'run-1');

    await vi.waitFor(() => {
      expect(mockGetRunStateSafe).toHaveBeenCalledWith(fakeRedis, 'tenant-1', 'run-1');
      expect(mockReadRecoveryEvents).toHaveBeenCalledWith(fakeRedis, 'tenant-1', 'run-1');
      expect(mockGetStepState).toHaveBeenCalledWith(fakeRedis, 'tenant-1', 'step-exec-1');
      expect(mockResetRecoveryEventCount).toHaveBeenCalledWith(fakeRedis, 'tenant-1', 'run-1');
    });

    // Verify snapshot was stored in Redis
    const snapshotKey = 'aflow:snapshot:tenant-1:run-1:latest';
    expect(fakeRedis.set).toHaveBeenCalledWith(snapshotKey, expect.any(String), 'EX', 86400);

    // Parse stored snapshot and verify structure
    const setCall = (fakeRedis.set as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[0] === snapshotKey,
    );
    const storedSnapshot = JSON.parse(setCall[1] as string);
    expect(storedSnapshot.version).toBe(1);
    expect(storedSnapshot.tenantId).toBe('tenant-1');
    expect(storedSnapshot.sessionId).toBe('run-1');
    expect(storedSnapshot.seq).toBe(75);
    expect(storedSnapshot.sessionHotState).toEqual(SAMPLE_RUN_STATE);
    expect(storedSnapshot.stepHotStates['step-exec-1']).toEqual(SAMPLE_STEP_STATE);
  });

  it('skips snapshot when run state is missing', async () => {
    mockGetRecoveryEventCount.mockResolvedValue(50);
    mockGetRunStateSafe.mockResolvedValue({ ok: false, kind: 'missing' });
    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:recovery_seq:tenant-1:run-1',
      '50',
    );

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = createSnapshotService({
      redis: fakeRedis,
      triggerConfig: { everyNEvents: 50 },
    });
    service.maybeSnapshot('tenant-1', 'run-1');

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot snapshot run run-1'));
    });

    expect(mockResetRecoveryEventCount).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('skips step state when no currentStepExecutionId and no recovery events', async () => {
    mockGetRecoveryEventCount.mockResolvedValue(50);
    mockGetRunStateSafe.mockResolvedValue({
      ok: true,
      state: { ...SAMPLE_RUN_STATE, currentStepExecutionId: undefined },
    });
    mockReadRecoveryEvents.mockResolvedValue([]); // No recovery events
    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:recovery_seq:tenant-1:run-1',
      '50',
    );

    const service = createSnapshotService({
      redis: fakeRedis,
      triggerConfig: { everyNEvents: 50 },
    });
    service.maybeSnapshot('tenant-1', 'run-1');

    await vi.waitFor(() => {
      expect(mockResetRecoveryEventCount).toHaveBeenCalled();
    });

    expect(mockGetStepState).not.toHaveBeenCalled();

    const setCall = (fakeRedis.set as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[0] === 'aflow:snapshot:tenant-1:run-1:latest',
    );
    const storedSnapshot = JSON.parse(setCall[1] as string);
    expect(Object.keys(storedSnapshot.stepHotStates)).toHaveLength(0);
  });

  it('uses custom trigger config', async () => {
    mockGetRecoveryEventCount.mockResolvedValue(10);
    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:recovery_seq:tenant-1:run-1',
      '10',
    );

    const service = createSnapshotService({
      redis: fakeRedis,
      triggerConfig: { everyNEvents: 10 },
    });
    service.maybeSnapshot('tenant-1', 'run-1');

    await vi.waitFor(() => {
      expect(mockGetRunStateSafe).toHaveBeenCalled();
      expect(mockResetRecoveryEventCount).toHaveBeenCalled();
    });
  });

  it('updates manifest with redis-prefixed snapshot ref', async () => {
    mockGetRecoveryEventCount.mockResolvedValue(50);
    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:recovery_seq:tenant-1:run-1',
      '75',
    );

    const mockUpdateSnapshot = vi.fn().mockResolvedValue(undefined);
    const mockManifestService = {
      trackRun: vi.fn(),
      updateStatus: vi.fn(),
      removeTerminal: vi.fn(),
      removeTerminalBatch: vi.fn(),
      getRepository: vi.fn().mockReturnValue({
        updateSnapshot: mockUpdateSnapshot,
      }),
    };

    const service = createSnapshotService({
      redis: fakeRedis,
      manifestService: mockManifestService,
      triggerConfig: { everyNEvents: 50 },
    });
    service.maybeSnapshot('tenant-1', 'run-1');

    await vi.waitFor(() => {
      expect(mockUpdateSnapshot).toHaveBeenCalledWith(
        'run-1',
        'redis:aflow:snapshot:tenant-1:run-1:latest',
        75,
      );
    });
  });

  it('logs error when snapshot fails, does not throw', async () => {
    mockGetRecoveryEventCount.mockResolvedValue(50);
    mockGetRunStateSafe.mockRejectedValue(new Error('Redis connection lost'));
    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:recovery_seq:tenant-1:run-1',
      '50',
    );

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = createSnapshotService({
      redis: fakeRedis,
      triggerConfig: { everyNEvents: 50 },
    });
    service.maybeSnapshot('tenant-1', 'run-1');

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const line = consoleSpy.mock.calls[0]?.[0];
      expect(typeof line).toBe('string');
      const parsed = JSON.parse(line as string) as {
        level?: string;
        message?: string;
        context?: { errorMessage?: string; runId?: string; tenantId?: string };
      };
      expect(parsed.level).toBe('error');
      expect(parsed.message).toContain('[SnapshotService]');
      expect(parsed.message).toContain('run-1');
      expect(parsed.context?.errorMessage).toBe('Redis connection lost');
      expect(parsed.context?.runId).toBe('run-1');
      expect(parsed.context?.tenantId).toBe('tenant-1');
    });

    consoleSpy.mockRestore();
  });

  it('warns when snapshot exceeds maxInlineBytes', async () => {
    mockGetRecoveryEventCount.mockResolvedValue(50);
    const largeState = {
      ...SAMPLE_RUN_STATE,
      largeData: 'x'.repeat(200),
    };
    mockGetRunStateSafe.mockResolvedValue({ ok: true, state: largeState });
    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:recovery_seq:tenant-1:run-1',
      '50',
    );

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = createSnapshotService({
      redis: fakeRedis,
      triggerConfig: { everyNEvents: 50, maxInlineBytes: 100 },
    });
    service.maybeSnapshot('tenant-1', 'run-1');

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('PayloadStore externalization pending'),
      );
    });

    expect(mockResetRecoveryEventCount).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  // ── forceSnapshot ─────────────────────────────────────────────────────

  it('forceSnapshot takes snapshot regardless of event count', async () => {
    // Event count is below threshold, but forceSnapshot should still take one
    mockGetRecoveryEventCount.mockResolvedValue(5);
    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:recovery_seq:tenant-1:run-1',
      '20',
    );

    const service = createSnapshotService({
      redis: fakeRedis,
      triggerConfig: { everyNEvents: 50 },
    });
    service.forceSnapshot('tenant-1', 'run-1');

    await vi.waitFor(() => {
      expect(mockGetRunStateSafe).toHaveBeenCalled();
      expect(mockResetRecoveryEventCount).toHaveBeenCalled();
    });

    // Verify snapshot was stored
    const snapshotKey = 'aflow:snapshot:tenant-1:run-1:latest';
    expect(fakeRedis.set).toHaveBeenCalledWith(snapshotKey, expect.any(String), 'EX', 86400);

    // Event count was NOT checked (forceSnapshot bypasses threshold)
    expect(mockGetRecoveryEventCount).not.toHaveBeenCalled();
  });

  // ── Active step discovery (parallel steps) ────────────────────────────

  it('captures ALL active steps from recovery events, not just currentStepExecutionId', async () => {
    mockGetRecoveryEventCount.mockResolvedValue(50);
    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:recovery_seq:tenant-1:run-1',
      '50',
    );

    // Recovery events show 3 steps scheduled, 1 completed → 2 active
    mockReadRecoveryEvents.mockResolvedValue([
      {
        version: 1,
        type: 'step.scheduled',
        tenantId: 'tenant-1',
        runId: 'run-1',
        seq: 1,
        timestamp: 1000,
        stepExecutionId: 'step-exec-1',
        data: {},
      },
      {
        version: 1,
        type: 'step.scheduled',
        tenantId: 'tenant-1',
        runId: 'run-1',
        seq: 2,
        timestamp: 1100,
        stepExecutionId: 'step-exec-2',
        data: {},
      },
      {
        version: 1,
        type: 'step.scheduled',
        tenantId: 'tenant-1',
        runId: 'run-1',
        seq: 3,
        timestamp: 1200,
        stepExecutionId: 'step-exec-3',
        data: {},
      },
      {
        version: 1,
        type: 'step.succeeded',
        tenantId: 'tenant-1',
        runId: 'run-1',
        seq: 4,
        timestamp: 1300,
        stepExecutionId: 'step-exec-1', // step-exec-1 completed
        data: {},
      },
    ]);

    // currentStepExecutionId points to step-exec-3 (last scheduled)
    mockGetRunStateSafe.mockResolvedValue({
      ok: true,
      state: { ...SAMPLE_RUN_STATE, currentStepExecutionId: 'step-exec-3' },
    });

    const service = createSnapshotService({
      redis: fakeRedis,
      triggerConfig: { everyNEvents: 50 },
    });
    service.maybeSnapshot('tenant-1', 'run-1');

    await vi.waitFor(() => {
      expect(mockResetRecoveryEventCount).toHaveBeenCalled();
    });

    // Should have read step states for step-exec-2 AND step-exec-3 (both active)
    // step-exec-1 is completed, should NOT be read
    expect(mockGetStepState).toHaveBeenCalledWith(fakeRedis, 'tenant-1', 'step-exec-2');
    expect(mockGetStepState).toHaveBeenCalledWith(fakeRedis, 'tenant-1', 'step-exec-3');

    // Verify snapshot contains both active steps
    const snapshotKey = 'aflow:snapshot:tenant-1:run-1:latest';
    const setCall = (fakeRedis.set as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[0] === snapshotKey,
    );
    const storedSnapshot = JSON.parse(setCall[1] as string);
    expect(Object.keys(storedSnapshot.stepHotStates)).toHaveLength(2);
    expect(storedSnapshot.stepHotStates['step-exec-2']).toEqual(SAMPLE_STEP_STATE_2);
    expect(storedSnapshot.stepHotStates['step-exec-3']).toEqual(SAMPLE_STEP_STATE_3);
    expect(storedSnapshot.stepHotStates['step-exec-1']).toBeUndefined();
  });

  it('includes currentStepExecutionId even if not in recovery events', async () => {
    mockGetRecoveryEventCount.mockResolvedValue(50);
    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:recovery_seq:tenant-1:run-1',
      '50',
    );

    // Recovery events are empty (edge case: events from before stream trimming)
    mockReadRecoveryEvents.mockResolvedValue([]);

    const service = createSnapshotService({
      redis: fakeRedis,
      triggerConfig: { everyNEvents: 50 },
    });
    service.maybeSnapshot('tenant-1', 'run-1');

    await vi.waitFor(() => {
      expect(mockResetRecoveryEventCount).toHaveBeenCalled();
    });

    // currentStepExecutionId is 'step-exec-1' — should still be included
    expect(mockGetStepState).toHaveBeenCalledWith(fakeRedis, 'tenant-1', 'step-exec-1');
  });

  it('recovery from snapshot with parallel steps preserves all step state', async () => {
    mockGetRecoveryEventCount.mockResolvedValue(50);
    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:recovery_seq:tenant-1:run-1',
      '50',
    );

    // Two parallel active steps
    mockReadRecoveryEvents.mockResolvedValue([
      {
        version: 1,
        type: 'step.scheduled',
        tenantId: 'tenant-1',
        runId: 'run-1',
        seq: 1,
        timestamp: 1000,
        stepExecutionId: 'step-exec-2',
        data: {},
      },
      {
        version: 1,
        type: 'step.scheduled',
        tenantId: 'tenant-1',
        runId: 'run-1',
        seq: 2,
        timestamp: 1100,
        stepExecutionId: 'step-exec-3',
        data: {},
      },
    ]);
    mockGetRunStateSafe.mockResolvedValue({
      ok: true,
      state: { ...SAMPLE_RUN_STATE, currentStepExecutionId: 'step-exec-3' },
    });

    const service = createSnapshotService({
      redis: fakeRedis,
      triggerConfig: { everyNEvents: 50 },
    });

    // Take snapshot
    service.maybeSnapshot('tenant-1', 'run-1');
    await vi.waitFor(() => {
      expect(mockResetRecoveryEventCount).toHaveBeenCalled();
    });

    // Load and verify both steps are in the snapshot
    const loaded = await service.loadSnapshot('tenant-1', 'run-1');
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.stepHotStates)).toHaveLength(2);
    expect(loaded!.stepHotStates['step-exec-2']).toBeDefined();
    expect(loaded!.stepHotStates['step-exec-3']).toBeDefined();
  });

  // ── loadSnapshot ──────────────────────────────────────────────────────

  it('returns null when no snapshot exists', async () => {
    const service = createSnapshotService({ redis: fakeRedis });
    const result = await service.loadSnapshot('tenant-1', 'run-1');
    expect(result).toBeNull();
  });

  it('loads and validates a valid snapshot', async () => {
    const runHotState = SAMPLE_RUN_STATE as unknown as Record<string, unknown>;
    const stepHotStates = {
      'step-exec-1': SAMPLE_STEP_STATE as unknown as Record<string, unknown>,
    };
    const checksum = computeExpectedChecksum(runHotState, stepHotStates);

    const snapshot = {
      version: 1,
      tenantId: 'tenant-1',
      sessionId: 'run-1',
      seq: 75,
      timestamp: Date.now(),
      sessionHotState: runHotState,
      stepHotStates,
      checksum,
    };

    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:snapshot:tenant-1:run-1:latest',
      JSON.stringify(snapshot),
    );

    const service = createSnapshotService({ redis: fakeRedis });
    const result = await service.loadSnapshot('tenant-1', 'run-1');

    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.seq).toBe(75);
    expect(result!.sessionHotState).toEqual(runHotState);
    expect(result!.stepHotStates).toEqual(stepHotStates);
    expect(result!.checksum).toBe(checksum);
  });

  it('returns null when snapshot has invalid checksum', async () => {
    const snapshot = {
      version: 1,
      tenantId: 'tenant-1',
      sessionId: 'run-1',
      seq: 75,
      timestamp: Date.now(),
      sessionHotState: SAMPLE_RUN_STATE,
      stepHotStates: {},
      checksum: 'invalid-checksum',
    };

    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:snapshot:tenant-1:run-1:latest',
      JSON.stringify(snapshot),
    );

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = createSnapshotService({ redis: fakeRedis });
    const result = await service.loadSnapshot('tenant-1', 'run-1');

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Checksum mismatch'));
    consoleSpy.mockRestore();
  });

  it('returns null when snapshot JSON is malformed', async () => {
    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:snapshot:tenant-1:run-1:latest',
      'not-valid-json',
    );

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = createSnapshotService({ redis: fakeRedis });
    const result = await service.loadSnapshot('tenant-1', 'run-1');

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse snapshot'),
      expect.any(String),
    );
    consoleSpy.mockRestore();
  });

  it('returns null when snapshot fails schema validation', async () => {
    const invalidSnapshot = {
      version: 2, // Invalid version
      tenantId: 'tenant-1',
    };

    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:snapshot:tenant-1:run-1:latest',
      JSON.stringify(invalidSnapshot),
    );

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = createSnapshotService({ redis: fakeRedis });
    const result = await service.loadSnapshot('tenant-1', 'run-1');

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid snapshot'));
    consoleSpy.mockRestore();
  });

  // ── Checksum determinism ──────────────────────────────────────────────

  it('produces deterministic checksums regardless of key order', async () => {
    const state1 = { b: 2, a: 1, c: { z: 1, y: 2 } };
    const state2 = { a: 1, c: { y: 2, z: 1 }, b: 2 };

    const checksum1 = computeExpectedChecksum(state1 as unknown as Record<string, unknown>, {});
    const checksum2 = computeExpectedChecksum(state2 as unknown as Record<string, unknown>, {});

    expect(checksum1).toBe(checksum2);
  });

  // ── Round-trip: take then load ────────────────────────────────────────

  it('round-trips: snapshot taken by maybeSnapshot can be loaded', async () => {
    mockGetRecoveryEventCount.mockResolvedValue(50);
    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:recovery_seq:tenant-1:run-1',
      '100',
    );

    const service = createSnapshotService({
      redis: fakeRedis,
      triggerConfig: { everyNEvents: 50 },
    });

    service.maybeSnapshot('tenant-1', 'run-1');
    await vi.waitFor(() => {
      expect(mockResetRecoveryEventCount).toHaveBeenCalled();
    });

    const loaded = await service.loadSnapshot('tenant-1', 'run-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.seq).toBe(100);
    expect(loaded!.sessionHotState).toEqual(SAMPLE_RUN_STATE);
    expect(loaded!.stepHotStates['step-exec-1']).toEqual(SAMPLE_STEP_STATE);

    const expectedChecksum = computeExpectedChecksum(
      SAMPLE_RUN_STATE as unknown as Record<string, unknown>,
      { 'step-exec-1': SAMPLE_STEP_STATE as unknown as Record<string, unknown> },
    );
    expect(loaded!.checksum).toBe(expectedChecksum);
  });

  // ── Per-run serialisation ─────────────────────────────────────────────

  it('serialises snapshots for the same run', async () => {
    const callOrder: string[] = [];

    let firstResolve: (() => void) | null = null;
    const firstPromise = new Promise<void>((resolve) => {
      firstResolve = resolve;
    });

    mockGetRecoveryEventCount.mockResolvedValueOnce(50).mockResolvedValueOnce(50);

    mockGetRunStateSafe
      .mockImplementationOnce(async () => {
        callOrder.push('first-start');
        await firstPromise;
        callOrder.push('first-end');
        return { ok: true, state: SAMPLE_RUN_STATE };
      })
      .mockImplementation(async () => {
        callOrder.push('second');
        return { ok: true, state: SAMPLE_RUN_STATE };
      });

    (fakeRedis as unknown as { _store: Map<string, string> })._store.set(
      'aflow:recovery_seq:tenant-1:run-1',
      '50',
    );

    const service = createSnapshotService({
      redis: fakeRedis,
      triggerConfig: { everyNEvents: 50 },
    });

    service.maybeSnapshot('tenant-1', 'run-1');
    service.maybeSnapshot('tenant-1', 'run-1');

    await new Promise((r) => setTimeout(r, 10));

    expect(callOrder).toEqual(['first-start']);

    firstResolve!();

    await vi.waitFor(() => {
      expect(callOrder).toContain('second');
    });

    const firstEndIdx = callOrder.indexOf('first-end');
    const secondIdx = callOrder.indexOf('second');
    expect(firstEndIdx).toBeLessThan(secondIdx);
  });
});
