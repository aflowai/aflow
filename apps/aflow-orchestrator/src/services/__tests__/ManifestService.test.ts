import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @aflow/database
const mockUpsert = vi.fn().mockResolvedValue(undefined);
const mockRemove = vi.fn().mockResolvedValue(undefined);
const mockRemoveBatch = vi.fn().mockResolvedValue(undefined);
const mockGetByShards = vi.fn().mockResolvedValue([]);
const mockGetByRunId = vi.fn().mockResolvedValue(null);
const mockUpdateSeq = vi.fn().mockResolvedValue(undefined);
const mockUpdateSnapshot = vi.fn().mockResolvedValue(undefined);

vi.mock('@aflow/database', () => ({
  createRecoverableRunsRepository: vi.fn(() => ({
    upsert: mockUpsert,
    remove: mockRemove,
    removeBatch: mockRemoveBatch,
    getByShards: mockGetByShards,
    getByRunId: mockGetByRunId,
    updateSeq: mockUpdateSeq,
    updateSnapshot: mockUpdateSnapshot,
  })),
}));

// Mock @aflow/redis for shardFor
vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    shardFor: vi.fn().mockReturnValue(42),
  };
});

import { createManifestService } from '../ManifestService.js';

const fakeDb = {} as unknown as import('drizzle-orm/postgres-js').PostgresJsDatabase;

describe('ManifestService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('trackRun inserts a new run into the manifest', async () => {
    const service = createManifestService(fakeDb);

    service.trackRun({
      runId: 'run-1',
      tenantId: 'tenant-1',
      status: 'RUNNING',
    });

    await vi.waitFor(() => {
      expect(mockUpsert).toHaveBeenCalledWith({
        runId: 'run-1',
        tenantId: 'tenant-1',
        shardId: 42,
        status: 'RUNNING',
      });
    });
  });

  it('updateStatus updates non-terminal status', async () => {
    const service = createManifestService(fakeDb);

    service.updateStatus('run-1', 'tenant-1', 'STALLED');

    await vi.waitFor(() => {
      expect(mockUpsert).toHaveBeenCalledWith({
        runId: 'run-1',
        tenantId: 'tenant-1',
        shardId: 42,
        status: 'STALLED',
      });
    });
  });

  it('updateStatus removes PAUSED runs (rehydrated on-demand)', async () => {
    const service = createManifestService(fakeDb);

    service.updateStatus('run-1', 'tenant-1', 'PAUSED');

    await vi.waitFor(() => {
      expect(mockRemove).toHaveBeenCalledWith('run-1');
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });

  it('updateStatus removes terminal runs (SUCCEEDED)', async () => {
    const service = createManifestService(fakeDb);

    service.updateStatus('run-1', 'tenant-1', 'SUCCEEDED');

    await vi.waitFor(() => {
      expect(mockRemove).toHaveBeenCalledWith('run-1');
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });

  it('updateStatus removes terminal runs (FAILED)', async () => {
    const service = createManifestService(fakeDb);

    service.updateStatus('run-1', 'tenant-1', 'FAILED');

    await vi.waitFor(() => {
      expect(mockRemove).toHaveBeenCalledWith('run-1');
    });
  });

  it('updateStatus removes terminal runs (CANCELLED)', async () => {
    const service = createManifestService(fakeDb);

    service.updateStatus('run-1', 'tenant-1', 'CANCELLED');

    await vi.waitFor(() => {
      expect(mockRemove).toHaveBeenCalledWith('run-1');
    });
  });

  it('removeTerminal removes a run', async () => {
    const service = createManifestService(fakeDb);

    service.removeTerminal('run-1');

    await vi.waitFor(() => {
      expect(mockRemove).toHaveBeenCalledWith('run-1');
    });
  });

  it('removeTerminalBatch removes multiple runs', async () => {
    const service = createManifestService(fakeDb);

    service.removeTerminalBatch(['run-1', 'run-2', 'run-3']);

    await vi.waitFor(() => {
      expect(mockRemoveBatch).toHaveBeenCalledWith(['run-1', 'run-2', 'run-3']);
    });
  });

  it('removeTerminalBatch does nothing for empty array', () => {
    const service = createManifestService(fakeDb);

    service.removeTerminalBatch([]);

    expect(mockRemoveBatch).not.toHaveBeenCalled();
  });

  it('getRepository returns the underlying repository', () => {
    const service = createManifestService(fakeDb);
    const repo = service.getRepository();

    expect(repo).toBeDefined();
    expect(repo.upsert).toBeDefined();
    expect(repo.getByShards).toBeDefined();
  });

  it('errors in async calls are logged, not thrown', async () => {
    mockUpsert.mockRejectedValueOnce(new Error('DB connection lost'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const service = createManifestService(fakeDb);
    service.trackRun({ runId: 'run-1', tenantId: 'tenant-1', status: 'RUNNING' });

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
      expect(parsed.message).toContain('[ManifestService]');
      expect(parsed.message).toContain('trackRun');
      expect(parsed.context?.errorMessage).toBe('DB connection lost');
      expect(parsed.context?.runId).toBe('run-1');
      expect(parsed.context?.tenantId).toBe('tenant-1');
    });

    consoleSpy.mockRestore();
  });

  // ── Ordering guarantee tests ──────────────────────────────────────────

  it('serialises operations for the same runId (prevents RUNNING→remove race)', async () => {
    // Simulate a slow upsert
    let upsertResolve: (() => void) | null = null;
    const upsertPromise = new Promise<void>((resolve) => {
      upsertResolve = resolve;
    });
    mockUpsert.mockImplementationOnce(() => upsertPromise);

    const service = createManifestService(fakeDb);

    // 1. Start trackRun (will block on slow upsert)
    service.trackRun({ runId: 'run-1', tenantId: 'tenant-1', status: 'RUNNING' });

    // 2. Immediately enqueue terminal removal (should wait for upsert)
    service.updateStatus('run-1', 'tenant-1', 'FAILED');

    // Let the chain start executing
    await new Promise((r) => setTimeout(r, 10));

    // At this point, remove should NOT have been called yet (upsert is blocking)
    expect(mockRemove).not.toHaveBeenCalled();

    // 3. Complete the upsert
    upsertResolve!();

    // 4. Wait for both to complete
    await vi.waitFor(() => {
      expect(mockUpsert).toHaveBeenCalledTimes(1);
      expect(mockRemove).toHaveBeenCalledTimes(1);
    });

    // Verify ordering: upsert was called before remove
    const upsertOrder = mockUpsert.mock.invocationCallOrder[0]!;
    const removeOrder = mockRemove.mock.invocationCallOrder[0]!;
    expect(upsertOrder).toBeLessThan(removeOrder);
  });

  it('allows concurrent operations for different runIds', async () => {
    let run1Resolve: (() => void) | null = null;
    mockUpsert.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          run1Resolve = resolve;
        }),
    );

    const service = createManifestService(fakeDb);

    // 1. Start slow operation for run-1
    service.trackRun({ runId: 'run-1', tenantId: 'tenant-1', status: 'RUNNING' });

    // 2. Start operation for run-2 (should not be blocked by run-1)
    service.trackRun({ runId: 'run-2', tenantId: 'tenant-1', status: 'RUNNING' });

    // run-2's upsert should complete independently
    await vi.waitFor(() => {
      expect(mockUpsert).toHaveBeenCalledTimes(2);
    });

    // Complete run-1
    run1Resolve!();
  });

  it('chains multiple operations for the same run in order', async () => {
    const callOrder: string[] = [];

    mockUpsert.mockImplementation(async (params: { status: string }) => {
      callOrder.push(`upsert:${params.status}`);
    });
    mockRemove.mockImplementation(async () => {
      callOrder.push('remove');
    });

    const service = createManifestService(fakeDb);

    // Enqueue: RUNNING → STALLED → RUNNING → SUCCEEDED(remove)
    service.trackRun({ runId: 'run-1', tenantId: 'tenant-1', status: 'RUNNING' });
    service.updateStatus('run-1', 'tenant-1', 'STALLED');
    service.updateStatus('run-1', 'tenant-1', 'RUNNING');
    service.updateStatus('run-1', 'tenant-1', 'SUCCEEDED');

    await vi.waitFor(() => {
      expect(callOrder).toEqual(['upsert:RUNNING', 'upsert:STALLED', 'upsert:RUNNING', 'remove']);
    });
  });
});
