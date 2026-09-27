import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSessionState = vi.fn();
const mockGetStepState = vi.fn();
const mockUpdateSessionState = vi.fn();
const mockUpdateStepState = vi.fn();
const mockMarkSessionDirty = vi.fn();
const mockAppendSessionEvent = vi.fn();
const mockAddStepResult = vi.fn();
const mockRemoveWaitingChild = vi.fn();
const mockLeaveChildWaitToRunning = vi.fn();

vi.mock('@aflow/redis', () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  getStepState: (...args: unknown[]) => mockGetStepState(...args),
  updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  updateStepState: (...args: unknown[]) => mockUpdateStepState(...args),
  markSessionDirty: (...args: unknown[]) => mockMarkSessionDirty(...args),
  appendSessionEvent: (...args: unknown[]) => mockAppendSessionEvent(...args),
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  removeWaitingChild: (...args: unknown[]) => mockRemoveWaitingChild(...args),
}));

vi.mock('../../helpers/delegationState.js', () => ({
  leaveChildWaitToRunning: (...args: unknown[]) => mockLeaveChildWaitToRunning(...args),
}));

vi.mock('@aflow/memory-paths', () => ({
  extractVirtualPathToolCallIds: () => [],
}));

import { resumeParentOnChildComplete } from '../resumeParentOnChildComplete.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const PARENT = 'parent-session';

const baseChildState = {
  parentSessionId: PARENT,
  parentStepExecutionId: 'parent-step-A',
  agentId: 'cybernetic-runner',
  finalOutputRef: undefined,
  errorRef: undefined,
};

const baseParentState = {
  sessionId: PARENT,
  status: 'WAITING_ON_CHILD' as const,
  traceId: 'trace-1',
};

const baseStepState = {
  stepId: 'start-workflow',
  stepType: 'agent' as const,
  attempt: 1,
  parentStepExecutionId: null,
  operationId: 'agent.control.delegate',
  inputRef: 'inline:e30=',
};

describe('resumeParentOnChildComplete — multi-child delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStepState.mockResolvedValue(baseStepState);
  });

  it('emits a step result AND keeps session WAITING_ON_CHILD when other children remain', async () => {
    // Child A fails first; child B is still running (remaining=1).
    mockGetSessionState
      .mockResolvedValueOnce({
        ...baseChildState,
        sessionId: 'child-A',
        parentStepExecutionId: 'parent-step-A',
      })
      .mockResolvedValueOnce(baseParentState);
    mockRemoveWaitingChild.mockResolvedValue(1);

    await resumeParentOnChildComplete(
      {} as never,
      TENANT,
      'child-A',
      'FAILED',
      undefined,
      undefined,
      {
        code: 'WORKFLOW_ENGINE_BOOTSTRAP_FAILED',
        message: 'something went wrong',
        classification: 'internal',
        retryable: false,
      },
    );

    // BUG fix: must NOT skip the per-child step result on remaining > 0.
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const resultArg = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      stepExecutionId: string;
      sessionId: string;
    };
    expect(resultArg.status).toBe('FAILED');
    expect(resultArg.stepExecutionId).toBe('parent-step-A');
    expect(resultArg.sessionId).toBe(PARENT);

    // Session must stay WAITING_ON_CHILD — leaveChildWaitToRunning is for the LAST child only.
    expect(mockLeaveChildWaitToRunning).not.toHaveBeenCalled();

    // Step state reset PAUSED → STARTED so applyResult won't skip it.
    expect(mockUpdateStepState).toHaveBeenCalledWith(expect.anything(), TENANT, 'parent-step-A', {
      sessionId: PARENT,
      status: 'STARTED',
    });
  });

  it('emits a step result AND flips session to RUNNING when this is the last child', async () => {
    mockGetSessionState
      .mockResolvedValueOnce({
        ...baseChildState,
        sessionId: 'child-B',
        parentStepExecutionId: 'parent-step-B',
      })
      .mockResolvedValueOnce(baseParentState);
    mockRemoveWaitingChild.mockResolvedValue(0);

    await resumeParentOnChildComplete({} as never, TENANT, 'child-B', 'SUCCEEDED');

    expect(mockLeaveChildWaitToRunning).toHaveBeenCalledOnce();
    expect(mockAppendSessionEvent).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      PARENT,
      expect.objectContaining({ eventType: 'SessionResumed' }),
    );
    expect(mockAddStepResult).toHaveBeenCalledOnce();
    const resultArg = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      stepExecutionId: string;
    };
    expect(resultArg.status).toBe('SUCCEEDED');
    expect(resultArg.stepExecutionId).toBe('parent-step-B');
  });

  it('emits BOTH step results for parallel children that fail in sequence', async () => {
    // Child A fails (remaining=1), then child B fails (remaining=0).
    // Each addStepResult must target the correct parentStepExecutionId.
    mockGetSessionState
      .mockResolvedValueOnce({
        ...baseChildState,
        sessionId: 'child-A',
        parentStepExecutionId: 'parent-step-A',
      })
      .mockResolvedValueOnce(baseParentState)
      .mockResolvedValueOnce({
        ...baseChildState,
        sessionId: 'child-B',
        parentStepExecutionId: 'parent-step-B',
      })
      .mockResolvedValueOnce(baseParentState);
    mockRemoveWaitingChild.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const childError = {
      code: 'X',
      message: 'x',
      classification: 'internal' as const,
      retryable: false,
    };
    await resumeParentOnChildComplete(
      {} as never,
      TENANT,
      'child-A',
      'FAILED',
      undefined,
      undefined,
      childError,
    );
    await resumeParentOnChildComplete(
      {} as never,
      TENANT,
      'child-B',
      'FAILED',
      undefined,
      undefined,
      childError,
    );

    expect(mockAddStepResult).toHaveBeenCalledTimes(2);
    const firstStep = (mockAddStepResult.mock.calls[0]![1] as { stepExecutionId: string })
      .stepExecutionId;
    const secondStep = (mockAddStepResult.mock.calls[1]![1] as { stepExecutionId: string })
      .stepExecutionId;
    expect(firstStep).toBe('parent-step-A');
    expect(secondStep).toBe('parent-step-B');

    // Session-level resume happens only on the last child.
    expect(mockLeaveChildWaitToRunning).toHaveBeenCalledOnce();
  });
});
