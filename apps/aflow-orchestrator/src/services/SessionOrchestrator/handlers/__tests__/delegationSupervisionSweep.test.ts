import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSessionState = vi.fn();
const mockGetDelegationParent = vi.fn();
const mockPeek = vi.fn();
const mockRefresh = vi.fn();
const mockDrop = vi.fn();
const mockUpsertPending = vi.fn();
const mockReconcile = vi.fn();

vi.mock('@aflow/redis', () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  getDelegationParent: (...args: unknown[]) => mockGetDelegationParent(...args),
  upsertPendingDelegationCompletion: (...args: unknown[]) => mockUpsertPending(...args),
  peekDueDelegationSupervisionCandidates: (...args: unknown[]) => mockPeek(...args),
  refreshDelegationSupervisionCandidate: (...args: unknown[]) => mockRefresh(...args),
  dropDelegationSupervisionCandidate: (...args: unknown[]) => mockDrop(...args),
  DELEGATION_SUPERVISION_CHECK_INTERVAL_MS: 60_000,
}));

const mockLeaveChildWaitToRunning = vi.fn();
vi.mock('../../helpers/delegationState.js', () => ({
  leaveChildWaitToRunning: (...args: unknown[]) => mockLeaveChildWaitToRunning(...args),
}));

vi.mock('../reconcileParentDelegation.js', () => ({
  isActiveChildStatus: (status: string | undefined) =>
    ['QUEUED', 'RUNNING', 'WAITING_ON_CHILD', 'STALLED', 'CANCELLING'].includes(status ?? ''),
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

import { sweepDelegationSupervision } from '../delegationSupervisionSweep.js';

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const PARENT = '11111111-1111-4111-9111-111111111111';
const PARENT_STEP = '22222222-2222-4222-9222-222222222222';
const CHILD = '33333333-3333-4333-9333-333333333333';
const DUE_AT = 1_700_000_000_000;

function deps(overrides: Record<string, unknown> = {}) {
  return {
    redis: {} as never,
    payloadStore: {} as never,
    agentDefLoader: vi.fn(),
    maxBatch: 10,
    ...overrides,
  };
}

function armedParent(): void {
  mockPeek.mockResolvedValue([{ tenantId: TENANT, sessionId: PARENT, dueAtMs: DUE_AT }]);
}

describe('sweepDelegationSupervision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPeek.mockResolvedValue([]);
  });

  it('pushes a parent whose child is still running forward without acting on it', async () => {
    // The healthy case, and the one the sweep must never turn into an
    // escalation: a delegation may legitimately run for hours, and a live child
    // already carries its own stall candidate.
    armedParent();
    mockGetSessionState
      .mockResolvedValueOnce({ status: 'WAITING_ON_CHILD', waitingForChildSessionIds: [CHILD] })
      .mockResolvedValueOnce({ status: 'RUNNING', parentStepExecutionId: PARENT_STEP });

    const result = await sweepDelegationSupervision(deps());

    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockUpsertPending).not.toHaveBeenCalled();
    expect(mockDrop).not.toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalledWith(expect.anything(), TENANT, PARENT, expect.any(Number));
    expect(result.rescheduled).toBe(1);
    expect(result.reconciled).toBe(0);
  });

  it('hands a child that vanished before it could rest to the pending drain', async () => {
    // The gap this sweep exists for. The child never completed, so nothing armed
    // a pending entry, and no other watchdog is keyed on a hash that is gone.
    // Reconcile returns before it reads the parent, so it can never release it.
    armedParent();
    mockGetSessionState
      .mockResolvedValueOnce({ status: 'WAITING_ON_CHILD', waitingForChildSessionIds: [CHILD] })
      .mockResolvedValueOnce(null);
    mockReconcile.mockResolvedValue('child_state_missing');
    mockGetDelegationParent.mockResolvedValue({
      parentRunId: PARENT,
      parentStepExecutionId: PARENT_STEP,
    });

    const result = await sweepDelegationSupervision(deps());

    expect(mockUpsertPending).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      CHILD,
      PARENT,
      PARENT_STEP,
    );
    expect(result.escalatable).toBe(1);
    // Still armed: the entry is a hand-off, and the release it should produce is
    // what clears the marker.
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('reconciles a resting child without starting an escalation clock', async () => {
    // Writing a pending entry for a child reconcile can still handle would put a
    // healthy chain on the drain's path to a fabricated failure.
    armedParent();
    mockGetSessionState
      .mockResolvedValueOnce({ status: 'WAITING_ON_CHILD', waitingForChildSessionIds: [CHILD] })
      .mockResolvedValueOnce({ status: 'SUCCEEDED', parentStepExecutionId: PARENT_STEP });
    mockReconcile.mockResolvedValue('result_enqueued');

    const result = await sweepDelegationSupervision(deps());

    expect(mockReconcile).toHaveBeenCalledWith(expect.objectContaining({ childRunId: CHILD }));
    expect(mockUpsertPending).not.toHaveBeenCalled();
    expect(result.reconciled).toBe(1);
    expect(result.escalatable).toBe(0);
  });

  it('does not hand a vanished child over without a resolvable parent step', async () => {
    armedParent();
    mockGetSessionState
      .mockResolvedValueOnce({ status: 'WAITING_ON_CHILD', waitingForChildSessionIds: [CHILD] })
      .mockResolvedValueOnce(null);
    mockReconcile.mockResolvedValue('child_state_missing');
    mockGetDelegationParent.mockResolvedValue(null);

    const result = await sweepDelegationSupervision(deps());

    expect(mockUpsertPending).not.toHaveBeenCalled();
    expect(result.escalatable).toBe(0);
  });

  it('acts on the dead sibling of a live one and leaves the live one alone', async () => {
    const liveChild = '44444444-4444-4444-9444-444444444444';
    armedParent();
    mockGetSessionState
      .mockResolvedValueOnce({
        status: 'WAITING_ON_CHILD',
        waitingForChildSessionIds: [liveChild, CHILD],
      })
      .mockResolvedValueOnce({ status: 'RUNNING', parentStepExecutionId: PARENT_STEP })
      .mockResolvedValueOnce({ status: 'FAILED', parentStepExecutionId: PARENT_STEP });
    mockReconcile.mockResolvedValue('result_enqueued');

    await sweepDelegationSupervision(deps());

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith(expect.objectContaining({ childRunId: CHILD }));
  });

  it('drops a candidate whose parent is no longer waiting', async () => {
    armedParent();
    mockGetSessionState.mockResolvedValueOnce({ status: 'RUNNING' });

    const result = await sweepDelegationSupervision(deps());

    expect(mockDrop).toHaveBeenCalledWith(expect.anything(), TENANT, PARENT, DUE_AT);
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(result.dropped).toBe(1);
  });

  it('drops a candidate whose parent hot state is gone', async () => {
    armedParent();
    mockGetSessionState.mockResolvedValueOnce(null);

    const result = await sweepDelegationSupervision(deps());

    expect(mockDrop).toHaveBeenCalledWith(expect.anything(), TENANT, PARENT, DUE_AT);
    expect(result.dropped).toBe(1);
  });

  it('releases a wait that outlived every child it tracked', async () => {
    // Both release paths remove the child and clear the wait in two round
    // trips, so a process dying between them leaves exactly this. Nothing else
    // recovers it — the drain reads it as `parent_not_tracking_child` and
    // declines to escalate — so refreshing the marker would re-examine it until
    // the hot state aged out with the parent never released.
    armedParent();
    mockGetSessionState.mockResolvedValueOnce({
      status: 'WAITING_ON_CHILD',
      waitingForChildSessionIds: [],
    });

    const result = await sweepDelegationSupervision(deps());

    expect(mockLeaveChildWaitToRunning).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      PARENT,
      expect.objectContaining({ fromStatus: 'WAITING_ON_CHILD' }),
    );
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockUpsertPending).not.toHaveBeenCalled();
    expect(mockDrop).toHaveBeenCalledWith(expect.anything(), TENANT, PARENT, DUE_AT);
    expect(result.untracked).toBe(1);
  });

  it('skips a parent this instance does not own', async () => {
    // Sweeping is shared infra: a non-owner that refreshed would reset the
    // owner's clock, and one that dropped would hide the parent from it.
    armedParent();

    const result = await sweepDelegationSupervision(
      deps({ shardManager: { ownsRun: () => false } }),
    );

    expect(mockGetSessionState).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockDrop).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
  });

  it('leaves a parent armed when its own pass throws', async () => {
    armedParent();
    mockGetSessionState.mockRejectedValueOnce(new Error('redis down'));

    const result = await sweepDelegationSupervision(deps());

    expect(mockDrop).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
  });

  it('stops claiming more parents once the cycle budget is spent', async () => {
    const other = '55555555-5555-4555-9555-555555555555';
    mockPeek.mockResolvedValue([
      { tenantId: TENANT, sessionId: PARENT, dueAtMs: DUE_AT },
      { tenantId: TENANT, sessionId: other, dueAtMs: DUE_AT },
    ]);
    const controller = new AbortController();
    controller.abort();

    const result = await sweepDelegationSupervision(deps({ signal: controller.signal }));

    expect(mockGetSessionState).not.toHaveBeenCalled();
    expect(result.candidates).toBe(2);
    expect(result.processed).toBe(0);
  });
});
