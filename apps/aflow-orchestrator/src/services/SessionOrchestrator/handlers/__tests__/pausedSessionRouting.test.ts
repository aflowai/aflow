import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHotState } from '@aflow/redis';

const mockGetSessionState = vi.fn();
const mockDecrementShardActiveRuns = vi.fn();
vi.mock('@aflow/redis', () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  markRunInactive: (...args: unknown[]) => mockDecrementShardActiveRuns(...args),
  shardFor: () => 'shard-0',
}));

const mockRouteRunnerTerminalToHarness = vi.fn();
vi.mock('../../../cybernetic/WorkflowRunHarness.js', () => ({
  routeRunnerTerminalToHarness: (...args: unknown[]) => mockRouteRunnerTerminalToHarness(...args),
}));

// The real classifier is `err instanceof DelegationLifecycleUpsertFailed` —
// mirror that shape exactly so the rethrow tests exercise prototype semantics,
// not a looser name check the real module never implements.
const { UpsertFailed, mockEnqueuePendingAndReconcile } = vi.hoisted(() => {
  class DelegationLifecycleUpsertFailed extends Error {}
  return {
    UpsertFailed: DelegationLifecycleUpsertFailed,
    mockEnqueuePendingAndReconcile: vi.fn(),
  };
});
vi.mock('../enqueueDelegationCompletion.js', () => ({
  enqueuePendingAndReconcile: (...args: unknown[]) => mockEnqueuePendingAndReconcile(...args),
  isDelegationUpsertFailure: (err: unknown) => err instanceof UpsertFailed,
}));

const mockFailRun = vi.fn();
vi.mock('../failRun.js', () => ({
  failRun: (...args: unknown[]) => mockFailRun(...args),
}));

const mockFetchAgentDef = vi.fn();
vi.mock('../../helpers/fetchAgentDef.js', () => ({
  fetchAgentDef: (...args: unknown[]) => mockFetchAgentDef(...args),
}));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  logOrchestratorError: vi.fn(),
}));

import { routeSessionPauseToSubscribers } from '../pausedSessionRouting.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const RUN = '265a4135-2103-48f2-92ae-344c77c2c006';
const PARENT = '511c5fce-94b2-4347-ae8b-bdd532e6e3c4';
const PARENT_STEP = '6557a3ec-82db-4bef-8e36-2e05f1bfb861';
const CONTRACT = 'inline:eyJyZWFzb24iOiJpbnB1dF9yZXF1aXJlZCJ9';

const cleanupRun = vi.fn();
const updateStatus = vi.fn();
const deps = {
  redis: {} as never,
  payloadStore: {} as never,
  db: {} as never,
  guardrailGate: { cleanupRun },
  manifestService: { updateStatus },
};

function runnerState(overrides: Partial<SessionHotState> = {}): SessionHotState {
  return {
    sessionId: RUN,
    tenantId: TENANT,
    status: 'PAUSED',
    workflowExecution: { runId: 'wf-run-1', taskId: 'decide', attempt: 1 },
    ...overrides,
  } as SessionHotState;
}

function childState(overrides: Partial<SessionHotState> = {}): SessionHotState {
  return {
    sessionId: RUN,
    tenantId: TENANT,
    status: 'PAUSED',
    parentSessionId: PARENT,
    parentStepExecutionId: PARENT_STEP,
    ...overrides,
  } as SessionHotState;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDecrementShardActiveRuns.mockResolvedValue(undefined);
});

describe('routeSessionPauseToSubscribers', () => {
  it('routes a workflow-task runner pause to the harness with its contract', async () => {
    const state = runnerState();
    const outcome = await routeSessionPauseToSubscribers(deps, {
      tenantId: TENANT,
      runId: RUN,
      traceId: 'trace-1',
      runState: state,
      contractRef: CONTRACT,
      pauseReason: 'budget exceeded',
    });

    expect(outcome).toBe('harness_notified');
    expect(mockRouteRunnerTerminalToHarness).toHaveBeenCalledTimes(1);
    const [, routedState, kind, payloads] = mockRouteRunnerTerminalToHarness.mock.calls[0] as [
      unknown,
      { workflowExecution: unknown },
      string,
      { contractRef: string | null },
    ];
    expect(routedState.workflowExecution).toEqual(state.workflowExecution);
    expect(kind).toBe('PAUSED');
    expect(payloads.contractRef).toBe(CONTRACT);
    expect(mockFailRun).not.toHaveBeenCalled();
  });

  it('routes a delegated child pause to the parent reconcile with explicit linkage', async () => {
    const outcome = await routeSessionPauseToSubscribers(deps, {
      tenantId: TENANT,
      runId: RUN,
      runState: childState(),
      contractRef: CONTRACT,
      pauseReason: 'guardrail escalation',
    });

    expect(outcome).toBe('parent_notified');
    expect(mockEnqueuePendingAndReconcile).toHaveBeenCalledTimes(1);
    const [params] = mockEnqueuePendingAndReconcile.mock.calls[0] as [
      { parentRunId?: string; parentStepExecutionId?: string; reason: string },
    ];
    expect(params.parentRunId).toBe(PARENT);
    expect(params.parentStepExecutionId).toBe(PARENT_STEP);
    expect(params.reason).toBe('pause_routing');
    expect(mockRouteRunnerTerminalToHarness).not.toHaveBeenCalled();
  });

  it('does nothing for a session with no parent linkage — the human watching is the subscriber', async () => {
    const outcome = await routeSessionPauseToSubscribers(deps, {
      tenantId: TENANT,
      runId: RUN,
      runState: {
        sessionId: RUN,
        tenantId: TENANT,
        status: 'PAUSED',
      } as SessionHotState,
      contractRef: CONTRACT,
      pauseReason: 'awaiting input',
    });

    expect(outcome).toBe('not_autonomous');
    expect(mockRouteRunnerTerminalToHarness).not.toHaveBeenCalled();
    expect(mockEnqueuePendingAndReconcile).not.toHaveBeenCalled();
    expect(mockFailRun).not.toHaveBeenCalled();
  });

  it('fetches session state when the caller does not hold it', async () => {
    mockGetSessionState.mockResolvedValueOnce(runnerState());

    const outcome = await routeSessionPauseToSubscribers(deps, {
      tenantId: TENANT,
      runId: RUN,
      contractRef: null,
      pauseReason: 'invalid decision retries exhausted',
    });

    expect(mockGetSessionState).toHaveBeenCalledWith(deps.redis, TENANT, RUN);
    expect(outcome).toBe('harness_notified');
  });

  it('floors through the standard failure machinery when the harness is unreachable', async () => {
    mockRouteRunnerTerminalToHarness
      .mockRejectedValueOnce(new Error('workflow run row gone'))
      .mockResolvedValueOnce(undefined);

    const outcome = await routeSessionPauseToSubscribers(deps, {
      tenantId: TENANT,
      runId: RUN,
      runState: runnerState(),
      contractRef: CONTRACT,
      pauseReason: 'budget exceeded',
    });

    expect(outcome).toBe('failed_floor');
    // The floor is failRun — delegation-cleared fields, SessionFailed event,
    // parent reconcile — not a hand-rolled status write.
    expect(mockFailRun).toHaveBeenCalledTimes(1);
    const [, tenantId, runId, code, message] = mockFailRun.mock.calls[0] as [
      unknown,
      string,
      string,
      string,
      string,
    ];
    expect(tenantId).toBe(TENANT);
    expect(runId).toBe(RUN);
    expect(code).toBe('PAUSE_UNROUTABLE');
    expect(message).toContain('budget exceeded');
    // Plus the cleanup failRunWithCleanup would do.
    expect(cleanupRun).toHaveBeenCalledWith(TENANT, RUN);
    expect(mockDecrementShardActiveRuns).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledWith(RUN, TENANT, 'FAILED');
    // Second harness call is the last-resort FAILED notification.
    expect(mockRouteRunnerTerminalToHarness).toHaveBeenCalledTimes(2);
    expect((mockRouteRunnerTerminalToHarness.mock.calls[1] as unknown[])[2]).toBe('FAILED');
  });

  it('floors a child pause when reconcile is unreachable — failRun itself reconciles the parent with the error', async () => {
    mockEnqueuePendingAndReconcile.mockRejectedValueOnce(new Error('reconcile down'));

    const outcome = await routeSessionPauseToSubscribers(deps, {
      tenantId: TENANT,
      runId: RUN,
      runState: childState(),
      contractRef: CONTRACT,
      pauseReason: 'guardrail escalation',
    });

    expect(outcome).toBe('failed_floor');
    expect(mockFailRun).toHaveBeenCalledTimes(1);
    const [, , , , message] = mockFailRun.mock.calls[0] as [
      unknown,
      string,
      string,
      string,
      string,
    ];
    expect(message).toContain('guardrail escalation');
    // No workflowExecution → no harness FAILED attempt; the parent hears the
    // failure through failRun's own reconcile.
    expect(mockRouteRunnerTerminalToHarness).not.toHaveBeenCalled();
  });

  it('rethrows a delegation-upsert failure so the stream message is not acked and replay retries', async () => {
    mockEnqueuePendingAndReconcile.mockRejectedValueOnce(new UpsertFailed('durable upsert failed'));

    await expect(
      routeSessionPauseToSubscribers(deps, {
        tenantId: TENANT,
        runId: RUN,
        runState: childState(),
        contractRef: CONTRACT,
        pauseReason: 'guardrail escalation',
      }),
    ).rejects.toThrow('durable upsert failed');

    // Replay carries the retry — the run must NOT be failed under it.
    expect(mockFailRun).not.toHaveBeenCalled();
  });

  it('floors an upsert failure instead of rethrowing when replay cannot retry', async () => {
    mockEnqueuePendingAndReconcile.mockRejectedValueOnce(new UpsertFailed('durable upsert failed'));

    const outcome = await routeSessionPauseToSubscribers(deps, {
      tenantId: TENANT,
      runId: RUN,
      runState: childState(),
      contractRef: CONTRACT,
      pauseReason: 'missing input at start',
      replayCarriesRetry: false,
    });

    expect(outcome).toBe('failed_floor');
    expect(mockFailRun).toHaveBeenCalledTimes(1);
  });

  it('treats missing harness deps as an unreachable subscriber, not a silent skip', async () => {
    const outcome = await routeSessionPauseToSubscribers(
      { redis: deps.redis, payloadStore: deps.payloadStore },
      {
        tenantId: TENANT,
        runId: RUN,
        runState: runnerState(),
        contractRef: CONTRACT,
        pauseReason: 'budget exceeded',
      },
    );

    expect(outcome).toBe('failed_floor');
    expect(mockFailRun).toHaveBeenCalledTimes(1);
  });
});
