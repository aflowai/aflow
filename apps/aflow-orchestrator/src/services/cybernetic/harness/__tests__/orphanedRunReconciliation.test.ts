import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type { TenantId } from '@aflow/schemas';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

// ── mocks ──────────────────────────────────────────────────────────────────
const mockFindStalled = vi.fn();
const mockRunRecoveryPass = vi.fn();
const mockStampDeadline = vi.fn();
const mockDeriveLiveness = vi.fn();
const mockListPending = vi.fn();
const mockReadCursorVersion = vi.fn();

vi.mock('@aflow/cybernetic-runtime', () => ({
  findStalledRunsAcrossSpaces: (...a: unknown[]) => mockFindStalled(...a),
  runRecoveryPass: (...a: unknown[]) => mockRunRecoveryPass(...a),
  stampSchedulerDeadline: (...a: unknown[]) => mockStampDeadline(...a),
  deriveRunLiveness: (...a: unknown[]) => mockDeriveLiveness(...a),
  listCompletionPendingForRun: (...a: unknown[]) => mockListPending(...a),
  readSchedulerCursorVersion: (...a: unknown[]) => mockReadCursorVersion(...a),
  DEFAULT_STALLED_AFTER_MS: 60_000,
}));

const mockDispatch = vi.fn();
vi.mock('../dispatch.js', () => ({
  dispatchNextOrTerminate: (...a: unknown[]) => mockDispatch(...a),
}));

const mockCompleteRun = vi.fn();
vi.mock('../pauseResume.js', () => ({
  completeRun: (...a: unknown[]) => mockCompleteRun(...a),
}));

const mockLoadRun = vi.fn();
vi.mock('../helpers.js', () => ({
  loadRunByRunIdAcrossSpaces: (...a: unknown[]) => mockLoadRun(...a),
  isTerminalRunStatus: (s: string) => s === 'completed' || s === 'failed' || s === 'cancelled',
}));

import { reconcileOrphanedRunsForTenant } from '../orphanedRunReconciliation.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const deps = { db: {} as never, redis: {} as never, payloadStore: {} as never };

function runningRun(overrides: Record<string, unknown> = {}) {
  return { runId: 'run-z', status: 'running', tasks: [], startedAt: new Date(0), ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunRecoveryPass.mockResolvedValue(0);
  mockStampDeadline.mockResolvedValue(undefined);
  mockDispatch.mockResolvedValue(undefined);
  mockCompleteRun.mockResolvedValue(true);
  mockReadCursorVersion.mockResolvedValue(7);
});

describe('reconcileOrphanedRunsForTenant', () => {
  it('no candidates → no-op', async () => {
    mockFindStalled.mockResolvedValueOnce([]);
    const res = await reconcileOrphanedRunsForTenant(deps, TENANT);
    expect(res).toMatchObject({ scanned: 0, recovered: 0, failed: 0 });
    expect(mockLoadRun).not.toHaveBeenCalled();
  });

  it('window-A zombie with a live graph → re-dispatched (recovered, not failed)', async () => {
    mockFindStalled.mockResolvedValueOnce(['run-z']);
    mockLoadRun
      .mockResolvedValueOnce(runningRun()) // initial load
      .mockResolvedValueOnce(runningRun()); // after dispatch — still running
    mockDeriveLiveness.mockReturnValue({ liveness: 'stalled', reason: 'no tasks, stale' });
    mockListPending
      .mockResolvedValueOnce([]) // guard: no pending → true orphan
      .mockResolvedValueOnce([{ taskId: 't1' }]); // after dispatch: tracked work exists

    const res = await reconcileOrphanedRunsForTenant(deps, TENANT);

    expect(mockDispatch).toHaveBeenCalledOnce();
    expect(mockCompleteRun).not.toHaveBeenCalled();
    expect(mockStampDeadline).toHaveBeenCalled(); // supervision re-armed
    expect(res).toMatchObject({ recovered: 1, failed: 0 });
  });

  it('wedged zombie (dispatch creates no work, no terminate) → failed + waiters released', async () => {
    mockFindStalled.mockResolvedValueOnce(['run-z']);
    mockLoadRun.mockResolvedValueOnce(runningRun()).mockResolvedValueOnce(runningRun()); // still running after dispatch
    mockDeriveLiveness.mockReturnValue({ liveness: 'stalled', reason: 'wedged' });
    mockListPending
      .mockResolvedValueOnce([]) // guard
      .mockResolvedValueOnce([]); // after dispatch: still no tracked work

    const res = await reconcileOrphanedRunsForTenant(deps, TENANT);

    expect(mockCompleteRun).toHaveBeenCalledOnce();
    expect(mockCompleteRun.mock.calls[0]![3]).toMatchObject({
      status: 'failed',
      failure: { reason: 'workflow_run_orphaned', detail: 'wedged' },
    });
    expect(res).toMatchObject({ failed: 1, recovered: 0 });
  });

  it('a recovery that throws fails the run with what it threw on record', async () => {
    mockFindStalled.mockResolvedValueOnce(['run-z']);
    mockLoadRun.mockResolvedValueOnce(runningRun());
    mockDeriveLiveness.mockReturnValue({ liveness: 'stalled', reason: 'stale' });
    mockListPending.mockResolvedValueOnce([]);
    mockDispatch.mockRejectedValueOnce(new Error('workflow not resolvable'));

    await reconcileOrphanedRunsForTenant(deps, TENANT);

    const ending = mockCompleteRun.mock.calls[0]![3] as {
      status: string;
      failure: { reason: string; message: string };
    };
    expect(ending.status).toBe('failed');
    expect(ending.failure.reason).toBe('workflow_run_orphaned');
    expect(ending.failure.message).toContain('workflow not resolvable');
  });

  // A child run completing resumes its parent through a recorded task outcome,
  // and the same sweeper tick can reach the parent before the parent's
  // dependents are claimed. The verdict this pass reaches is bound to the
  // cursor version read before its first look, so that outcome voids it.
  it('binds the orphan verdict to the cursor version read before the run was looked at', async () => {
    mockFindStalled.mockResolvedValueOnce(['run-z']);
    mockLoadRun.mockResolvedValueOnce(runningRun()).mockResolvedValueOnce(runningRun());
    mockDeriveLiveness.mockReturnValue({ liveness: 'stalled', reason: 'no active tasks' });
    mockListPending.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await reconcileOrphanedRunsForTenant(deps, TENANT);

    expect(mockReadCursorVersion.mock.invocationCallOrder[0]!).toBeLessThan(
      mockLoadRun.mock.invocationCallOrder[0]!,
    );
    expect(mockCompleteRun.mock.calls[0]![3]).toMatchObject({
      status: 'failed',
      expectedSchedulerCursorVersion: 7,
    });
  });

  it('a run another path advanced during the pass is left running, not counted failed', async () => {
    mockFindStalled.mockResolvedValueOnce(['run-z']);
    mockLoadRun.mockResolvedValueOnce(runningRun()).mockResolvedValueOnce(runningRun());
    mockDeriveLiveness.mockReturnValue({ liveness: 'stalled', reason: 'no active tasks' });
    mockListPending.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    // The terminal CAS lost on the cursor version: the parent's review outcome
    // landed after this pass read the run.
    mockCompleteRun.mockResolvedValueOnce(false);

    const res = await reconcileOrphanedRunsForTenant(deps, TENANT);

    expect(res).toMatchObject({ failed: 0, skipped: 1 });
  });

  it('dispatch pauses the run (human first task, no pending row) → held, not failed', async () => {
    mockFindStalled.mockResolvedValueOnce(['run-z']);
    mockLoadRun
      .mockResolvedValueOnce(runningRun()) // initial: running + stalled
      .mockResolvedValueOnce(runningRun({ status: 'paused' })); // after dispatch: paused (HITL)
    mockDeriveLiveness
      .mockReturnValueOnce({ liveness: 'stalled', reason: 'orphan' }) // initial
      .mockReturnValueOnce({ liveness: 'waiting_for_input', reason: 'paused' }); // after dispatch
    mockListPending
      .mockResolvedValueOnce([]) // guard
      .mockResolvedValueOnce([]); // human task creates no completion-pending row

    const res = await reconcileOrphanedRunsForTenant(deps, TENANT);

    expect(mockCompleteRun).not.toHaveBeenCalled();
    expect(mockStampDeadline).toHaveBeenCalled();
    expect(res).toMatchObject({ recovered: 1, failed: 0 });
  });

  it('dispatch terminates the run (all tasks already terminal) → recovered, not failed', async () => {
    mockFindStalled.mockResolvedValueOnce(['run-z']);
    mockLoadRun
      .mockResolvedValueOnce(runningRun())
      .mockResolvedValueOnce(runningRun({ status: 'completed' })); // dispatch completed it
    mockDeriveLiveness.mockReturnValue({ liveness: 'stalled', reason: 'all done, not terminated' });
    mockListPending.mockResolvedValueOnce([]);

    const res = await reconcileOrphanedRunsForTenant(deps, TENANT);

    expect(mockCompleteRun).not.toHaveBeenCalled();
    expect(res).toMatchObject({ recovered: 1, failed: 0 });
  });

  it('run owned by completion-pending sweeper → skipped, not touched', async () => {
    mockFindStalled.mockResolvedValueOnce(['run-z']);
    mockLoadRun.mockResolvedValueOnce(runningRun());
    mockDeriveLiveness.mockReturnValue({ liveness: 'stalled', reason: 'stale' });
    mockListPending.mockResolvedValueOnce([{ taskId: 't1' }]); // has pending tracking

    const res = await reconcileOrphanedRunsForTenant(deps, TENANT);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockCompleteRun).not.toHaveBeenCalled();
    expect(mockStampDeadline).toHaveBeenCalled(); // re-armed so we stop re-selecting
    expect(res).toMatchObject({ skipped: 1, failed: 0, recovered: 0 });
  });

  it('false positive (deadline expired but executing) → re-stamped, skipped', async () => {
    mockFindStalled.mockResolvedValueOnce(['run-z']);
    mockLoadRun.mockResolvedValueOnce(runningRun());
    mockDeriveLiveness.mockReturnValue({ liveness: 'executing', reason: 'live work' });

    const res = await reconcileOrphanedRunsForTenant(deps, TENANT);

    expect(mockListPending).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockCompleteRun).not.toHaveBeenCalled();
    expect(mockStampDeadline).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ skipped: 1 });
  });

  it('run paused between selection and load → skipped (paused runs are never orphans)', async () => {
    mockFindStalled.mockResolvedValueOnce(['run-z']);
    mockLoadRun.mockResolvedValueOnce(runningRun({ status: 'paused' }));

    const res = await reconcileOrphanedRunsForTenant(deps, TENANT);

    expect(mockDeriveLiveness).not.toHaveBeenCalled();
    expect(mockCompleteRun).not.toHaveBeenCalled();
    expect(res).toMatchObject({ skipped: 1 });
  });
});
