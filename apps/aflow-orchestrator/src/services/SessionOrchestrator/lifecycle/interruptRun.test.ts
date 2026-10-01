import { beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION = '99999999-2222-3333-4444-555555555555';
const NONE_RUN = '11111111-2222-3333-4444-555555555555';
const PARKED_RUN = '22222222-2222-3333-4444-555555555555';

/** The session's pending waiter rows, served by both ledger reads. */
const waiterRows: Array<{
  id: string;
  runId: string;
  waiterSessionId: string;
  waiterStepExecutionId: string | null;
}> = [];

vi.mock('@aflow/cybernetic-runtime', () => ({
  loadPendingWaitersForSession: vi.fn(() => Promise.resolve([...waiterRows])),
  loadParkedStepWaitersForSession: vi.fn(() =>
    Promise.resolve(waiterRows.filter((row) => row.waiterStepExecutionId !== null)),
  ),
}));

const mockGetSessionStateSafe = vi.fn();
const mockUpdateSessionState = vi.fn();
vi.mock('@aflow/redis', () => ({
  isSessionCorrupt: vi.fn().mockResolvedValue(false),
  getSessionStateSafe: (...args: unknown[]) => mockGetSessionStateSafe(...args),
  getStepState: vi.fn().mockResolvedValue(null),
  updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  hasAvailableExecutor: vi.fn().mockResolvedValue(true),
}));

const mockCancelWorkflowRun = vi.fn();
vi.mock('../../cybernetic/WorkflowRunHarness.js', () => ({
  cancelRun: (...args: unknown[]) => mockCancelWorkflowRun(...args),
}));

vi.mock('../handlers/interruptCascade.js', () => ({
  cascadeInterruptToChildren: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logOrchestratorError: vi.fn(),
}));

import { createInterruptRun } from './interruptRun.js';
import { ControlConflictError } from '../../../lib/controlConflict.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as never;

const forceCompleteInFlightStep = vi.fn();
const interruptRun = createInterruptRun({
  deps: { db: {}, redis: {}, payloadStore: {} },
  harnessDeps: {},
  forceCompleteInFlightStep,
} as never);

function interrupt() {
  return interruptRun({
    tenantId: TENANT,
    runId: SESSION,
    traceId: 'trace-1',
    idempotencyKey: `interrupt:${SESSION}`,
  } as never);
}

function sessionIn(state: Record<string, unknown>) {
  mockGetSessionStateSafe.mockResolvedValue({ ok: true, state: { sessionId: SESSION, ...state } });
}

beforeEach(() => {
  vi.clearAllMocks();
  forceCompleteInFlightStep.mockResolvedValue(false);
  waiterRows.length = 0;
  waiterRows.push({
    id: 'waiter-none',
    runId: NONE_RUN,
    waiterSessionId: SESSION,
    waiterStepExecutionId: null,
  });
});

describe('interruptRun on a session that started a run without waiting on it', () => {
  it('refuses while the session rests at its prompt', async () => {
    sessionIn({ status: 'PAUSED', pauseType: 'user_input', currentStepExecutionId: 'step-1' });

    const refusal = await interrupt().catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(ControlConflictError);
    expect((refusal as ControlConflictError).conflictCode).toBe('run_not_interruptible');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  it('interrupts a turn in flight and leaves the run it started running', async () => {
    sessionIn({ status: 'RUNNING', currentStepExecutionId: 'step-1' });

    await expect(interrupt()).resolves.toEqual({ status: 'RUNNING' });

    expect(mockUpdateSessionState).toHaveBeenCalledWith(expect.anything(), TENANT, SESSION, {
      interruptRequested: true,
    });
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  it('cancels only the run a step of it is parked on', async () => {
    waiterRows.push({
      id: 'waiter-parked',
      runId: PARKED_RUN,
      waiterSessionId: SESSION,
      waiterStepExecutionId: 'step-parked',
    });
    sessionIn({
      status: 'PAUSED',
      pauseType: 'external_dependency',
      currentStepExecutionId: 'step-parked',
      waitingOnWorkflowRunId: PARKED_RUN,
    });

    await interrupt();

    expect(mockCancelWorkflowRun).toHaveBeenCalledOnce();
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith(expect.anything(), TENANT, PARKED_RUN, {
      cancelledBy: 'operator',
      reason: 'helmsman_interrupted',
    });
  });
});
