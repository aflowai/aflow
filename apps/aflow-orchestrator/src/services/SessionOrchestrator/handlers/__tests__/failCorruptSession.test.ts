/**
 * Regression test for the 2026-05-06 wedge → architectural fix.
 *
 * Before this change: a session whose hot state failed Zod parse was
 * silently quarantined. Every subsequent step result destined for that
 * session was dropped (`Skipping result for corrupt run`). The parent
 * session, waiting on this child via `agent.control.delegate`, sat in
 * `WAITING_ON_CHILD` forever. The user watched the entire delegation
 * chain wedge with no chat-visible error.
 *
 * After this change: corruption triggers an explicit FAILED transition
 * with a parent cascade. The parent gets a typed FAILED step result, its
 * `onFailure` routing fires, the user sees a clean error.
 *
 * This test pins the behavior end-to-end with mocked Redis + the
 * orchestrator helpers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsSessionCorrupt = vi.fn();
const mockSalvageCorruptStateFields = vi.fn();
const mockSetSessionState = vi.fn();
const mockClearQuarantineMark = vi.fn();
const mockUpdateSessionState = vi.fn();
const mockAppendSessionEvent = vi.fn();
const mockMarkSessionDirty = vi.fn();
const mockGetSessionState = vi.fn();

vi.mock('@aflow/redis', () => ({
  markRunInactive: vi.fn(async () => 0),
  isSessionCorrupt: (...args: unknown[]) => mockIsSessionCorrupt(...args),
  salvageCorruptStateFields: (...args: unknown[]) => mockSalvageCorruptStateFields(...args),
  setSessionState: (...args: unknown[]) => mockSetSessionState(...args),
  clearQuarantineMark: (...args: unknown[]) => mockClearQuarantineMark(...args),
  updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  appendSessionEvent: (...args: unknown[]) => mockAppendSessionEvent(...args),
  markSessionDirty: (...args: unknown[]) => mockMarkSessionDirty(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  appendRecoveryEventsToPipeline: vi.fn(),
  upsertPendingDelegationCompletion: vi.fn().mockResolvedValue(true),
}));

const mockReconcileParentDelegationForChild = vi.fn();
vi.mock('../reconcileParentDelegation.js', () => ({
  reconcileParentDelegationForChild: (...args: unknown[]) =>
    mockReconcileParentDelegationForChild(...args),
}));

vi.mock('../../helpers/recoveryEmitter.js', () => ({
  buildRunStatusChangedRecoveryEvent: vi.fn(async () => []),
}));

vi.mock('../forwardChildEvent.js', () => ({
  forwardEventToParent: vi.fn(),
}));

vi.mock('@aflow/database', () => ({
  tenantIdToSchemaName: (id: string) => `t_${id.replace(/-/g, '')}`,
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

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const RUN = '11111111-1111-4111-9111-111111111111';
const PARENT_RUN = '22222222-2222-4222-9222-222222222222';
const PARENT_STEP = '33333333-3333-4333-9333-333333333333';

const mockRedis = {
  pipeline: () => ({ exec: vi.fn(async () => []) }),
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('failCorruptSessionAndCascade', () => {
  it('skips silently when the session is no longer marked corrupt (idempotent re-entry)', async () => {
    mockIsSessionCorrupt.mockResolvedValueOnce(false);
    const { failCorruptSessionAndCascade } = await import('../failCorruptSession.js');
    await failCorruptSessionAndCascade(mockRedis, TENANT, RUN);
    expect(mockSalvageCorruptStateFields).not.toHaveBeenCalled();
    expect(mockSetSessionState).not.toHaveBeenCalled();
    expect(mockReconcileParentDelegationForChild).not.toHaveBeenCalled();
  });

  it('clears the corrupt marker as a last resort when no quarantined data is recoverable', async () => {
    mockIsSessionCorrupt.mockResolvedValueOnce(true);
    mockSalvageCorruptStateFields.mockResolvedValueOnce(null);
    const { failCorruptSessionAndCascade } = await import('../failCorruptSession.js');
    await failCorruptSessionAndCascade(mockRedis, TENANT, RUN);
    expect(mockClearQuarantineMark).toHaveBeenCalledTimes(1);
    expect(mockSetSessionState).not.toHaveBeenCalled();
    expect(mockReconcileParentDelegationForChild).not.toHaveBeenCalled();
  });

  it('restores minimal state, clears marker, and cascades FAILED to parent', async () => {
    mockIsSessionCorrupt.mockResolvedValueOnce(true);
    mockSalvageCorruptStateFields.mockResolvedValueOnce({
      target: { kind: 'platform-role', systemRole: 'cybernetic-runner' },
      agentVersion: '1',
      parentSessionId: PARENT_RUN,
      parentStepExecutionId: PARENT_STEP,
      spaceId: 'space-1',
      traceId: 'trace-1',
    });
    mockGetSessionState.mockResolvedValue({
      sessionId: RUN,
      spaceId: 'space-1',
      target: { kind: 'platform-role', systemRole: 'cybernetic-runner' },
      parentSessionId: PARENT_RUN,
      parentStepExecutionId: PARENT_STEP,
    });
    const { failCorruptSessionAndCascade } = await import('../failCorruptSession.js');
    await failCorruptSessionAndCascade(
      mockRedis,
      TENANT,
      RUN,
      "Expected 'true' | 'until_pause' | 'false', received boolean",
    );

    // Minimal state restored with salvaged parent fields.
    expect(mockSetSessionState).toHaveBeenCalledTimes(1);
    const restoredState = mockSetSessionState.mock.calls[0]?.[1] as {
      sessionId: string;
      status: string;
      parentSessionId?: string;
      parentStepExecutionId?: string;
      target: { kind: string; systemRole?: string };
    };
    expect(restoredState.sessionId).toBe(RUN);
    expect(restoredState.status).toBe('RUNNING');
    expect(restoredState.parentSessionId).toBe(PARENT_RUN);
    expect(restoredState.parentStepExecutionId).toBe(PARENT_STEP);
    expect(restoredState.target).toEqual({
      kind: 'platform-role',
      systemRole: 'cybernetic-runner',
    });

    // Marker cleared before cascade so subsequent reads see a valid state.
    expect(mockClearQuarantineMark).toHaveBeenCalledTimes(1);

    // failRun → updateSessionState({ status: 'FAILED' }, recoveryEvents)
    // — the actual FAILED transition. Mocked at the @aflow/redis boundary.
    expect(mockUpdateSessionState).toHaveBeenCalledWith(
      mockRedis,
      TENANT,
      RUN,
      expect.objectContaining({ status: 'FAILED' }),
      expect.anything(),
    );

    // SessionFailed event emitted with the typed corruption code.
    expect(mockAppendSessionEvent).toHaveBeenCalled();
    const events = mockAppendSessionEvent.mock.calls.map(
      (c) => c[3] as { eventType: string; metadata: { errorCode: string } },
    );
    const failedEvent = events.find((e) => e.eventType === 'SessionFailed');
    expect(failedEvent?.metadata?.errorCode).toBe('SESSION_STATE_CORRUPT');

    // Parent cascade fires.
    expect(mockReconcileParentDelegationForChild).toHaveBeenCalledTimes(1);
    expect(mockReconcileParentDelegationForChild).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        childRunId: RUN,
        reason: 'failRun',
        childError: expect.objectContaining({
          code: 'SESSION_STATE_CORRUPT',
          classification: 'internal',
        }),
      }),
    );
  });

  it('uses placeholder agent identity when salvage data lacks target (defensive)', async () => {
    mockIsSessionCorrupt.mockResolvedValueOnce(true);
    mockSalvageCorruptStateFields.mockResolvedValueOnce({
      // No target / agentVersion in salvaged data
      parentSessionId: PARENT_RUN,
      parentStepExecutionId: PARENT_STEP,
    });
    const { failCorruptSessionAndCascade } = await import('../failCorruptSession.js');
    await failCorruptSessionAndCascade(mockRedis, TENANT, RUN);

    const restoredState = mockSetSessionState.mock.calls[0]?.[1] as {
      target: { kind: string; systemRole?: string };
      agentVersion: string;
    };
    expect(restoredState.target).toEqual({ kind: 'platform-role', systemRole: 'unknown' });
    expect(restoredState.agentVersion).toBe('1');
    // Cascade still fires because parent fields are present.
    expect(mockReconcileParentDelegationForChild).toHaveBeenCalledTimes(1);
  });
});
