import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUpsert = vi.fn();
const mockReconcile = vi.fn();
const mockGetSessionState = vi.fn();

vi.mock('@aflow/redis', () => ({
  upsertPendingDelegationCompletion: (...args: unknown[]) => mockUpsert(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
}));

vi.mock('../reconcileParentDelegation.js', () => ({
  reconcileParentDelegationForChild: (...args: unknown[]) => mockReconcile(...args),
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

import {
  enqueuePendingAndReconcile,
  isDelegationUpsertFailure,
  DelegationLifecycleUpsertFailed,
} from '../enqueueDelegationCompletion.js';

const TENANT = 'tenant-X';
const PARENT = '11111111-1111-4111-9111-111111111111';
const PARENT_STEP = '22222222-2222-4222-9222-222222222222';
const CHILD = '33333333-3333-4333-9333-333333333333';

describe('enqueuePendingAndReconcile — fail-closed on upsert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockReset();
    mockReconcile.mockReset();
    mockGetSessionState.mockReset();
  });

  it('rethrows DelegationLifecycleUpsertFailed when upsert fails; reconcile is NOT called', async () => {
    mockUpsert.mockRejectedValueOnce(new Error('redis network blip'));
    await expect(
      enqueuePendingAndReconcile({
        redis: {} as never,
        tenantId: TENANT,
        childRunId: CHILD,
        reason: 'test',
        parentRunId: PARENT,
        parentStepExecutionId: PARENT_STEP,
      }),
    ).rejects.toBeInstanceOf(DelegationLifecycleUpsertFailed);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('isDelegationUpsertFailure narrows correctly', async () => {
    mockUpsert.mockRejectedValueOnce(new Error('boom'));
    try {
      await enqueuePendingAndReconcile({
        redis: {} as never,
        tenantId: TENANT,
        childRunId: CHILD,
        reason: 'test',
        parentRunId: PARENT,
        parentStepExecutionId: PARENT_STEP,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(isDelegationUpsertFailure(err)).toBe(true);
    }
    // A vanilla Error is NOT an upsert failure.
    expect(isDelegationUpsertFailure(new Error('something else'))).toBe(false);
    expect(isDelegationUpsertFailure(undefined)).toBe(false);
    expect(isDelegationUpsertFailure(null)).toBe(false);
  });

  it('reconcile failure is NOT treated as an upsert failure (typed outcome path)', async () => {
    mockUpsert.mockResolvedValueOnce(true);
    mockReconcile.mockRejectedValueOnce(new Error('reconcile threw'));
    try {
      await enqueuePendingAndReconcile({
        redis: {} as never,
        tenantId: TENANT,
        childRunId: CHILD,
        reason: 'test',
        parentRunId: PARENT,
        parentStepExecutionId: PARENT_STEP,
      });
      expect.fail('should have thrown');
    } catch (err) {
      // It throws (because reconcile threw) but it is NOT a
      // DelegationLifecycleUpsertFailed — callers will log+swallow.
      expect(isDelegationUpsertFailure(err)).toBe(false);
    }
  });

  it('happy path: upsert called, then reconcile, returns reconcile outcome', async () => {
    mockUpsert.mockResolvedValueOnce(true);
    mockReconcile.mockResolvedValueOnce('result_enqueued');
    const outcome = await enqueuePendingAndReconcile({
      redis: {} as never,
      tenantId: TENANT,
      childRunId: CHILD,
      reason: 'test',
      parentRunId: PARENT,
      parentStepExecutionId: PARENT_STEP,
    });
    expect(outcome).toBe('result_enqueued');
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it('returns "no_parent_linkage" without upsert when child has no parent fields', async () => {
    mockGetSessionState.mockResolvedValueOnce({
      sessionId: CHILD,
      tenantId: TENANT,
      // no parentSessionId / parentStepExecutionId
    });
    const outcome = await enqueuePendingAndReconcile({
      redis: {} as never,
      tenantId: TENANT,
      childRunId: CHILD,
      reason: 'test',
      // parentRunId/parentStepExecutionId omitted on purpose
    });
    expect(outcome).toBe('no_parent_linkage');
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});
