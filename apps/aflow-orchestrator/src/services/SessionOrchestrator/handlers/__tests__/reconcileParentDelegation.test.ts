import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSessionState = vi.fn();
const mockUpdateSessionState = vi.fn();
const mockMarkSessionDirty = vi.fn();
const mockHookSafe = vi.fn();
const mockResumeParentOnChildComplete = vi.fn();
const mockBubbleChildPauseToParent = vi.fn();

vi.mock('@aflow/redis', () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  markSessionDirty: (...args: unknown[]) => mockMarkSessionDirty(...args),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  cyberneticHookSafe: (...args: unknown[]) => mockHookSafe(...args),
}));

vi.mock('../resumeParentOnChildComplete.js', () => ({
  resumeParentOnChildComplete: (...args: unknown[]) => mockResumeParentOnChildComplete(...args),
}));

vi.mock('../bubbleChildPause.js', () => ({
  bubbleChildPauseToParent: (...args: unknown[]) => mockBubbleChildPauseToParent(...args),
}));

import { reconcileParentDelegationForChild } from '../reconcileParentDelegation.js';

describe('reconcileParentDelegationForChild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears impossible child-wait metadata for terminal parent', async () => {
    mockGetSessionState
      .mockResolvedValueOnce({
        sessionId: 'child-1',
        parentSessionId: 'parent-1',
        parentStepExecutionId: 'step-1',
        status: 'SUCCEEDED',
      })
      .mockResolvedValueOnce({
        sessionId: 'parent-1',
        status: 'SUCCEEDED',
        spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
        waitingForChildSessionIds: ['child-1'],
        delegationPauseSource: 'child_running',
      });

    await reconcileParentDelegationForChild({
      redis: {} as never,
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      childRunId: 'child-1',
      reason: 'test:terminal_parent',
    });

    expect(mockUpdateSessionState).toHaveBeenCalledWith(
      expect.anything(),
      'a0000000-0000-0000-0000-000000000001',
      'parent-1',
      expect.objectContaining({
        waitingForChildSessionIds: [],
        delegationPauseSource: undefined,
        pausedChildSessionId: undefined,
      }),
    );
    expect(mockMarkSessionDirty).toHaveBeenCalledWith(
      expect.anything(),
      'a0000000-0000-0000-0000-000000000001',
      'parent-1',
    );
    expect(mockHookSafe).toHaveBeenCalledWith(
      'orphan-recovery',
      expect.any(Function),
      expect.objectContaining({ runId: 'parent-1' }),
    );
  });

  it('bubbles paused child state when parent is tracking child', async () => {
    mockGetSessionState
      .mockResolvedValueOnce({
        sessionId: 'child-2',
        parentSessionId: 'parent-2',
        parentStepExecutionId: 'step-2',
        status: 'PAUSED',
      })
      .mockResolvedValueOnce({
        sessionId: 'parent-2',
        status: 'WAITING_ON_CHILD',
        waitingForChildSessionIds: ['child-2'],
      });

    await reconcileParentDelegationForChild({
      redis: {} as never,
      payloadStore: {} as never,
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      childRunId: 'child-2',
      reason: 'test:pause',
      agentDefLoader: vi.fn() as never,
    });

    expect(mockBubbleChildPauseToParent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'a0000000-0000-0000-0000-000000000001',
      'child-2',
      expect.any(Function),
    );
  });

  it('resumes parent with synthetic failed outcome when child cancelled', async () => {
    mockGetSessionState
      .mockResolvedValueOnce({
        sessionId: 'child-3',
        parentSessionId: 'parent-3',
        parentStepExecutionId: 'step-3',
        status: 'CANCELLED',
      })
      .mockResolvedValueOnce({
        sessionId: 'parent-3',
        status: 'WAITING_ON_CHILD',
        waitingForChildSessionIds: ['child-3'],
      });

    await reconcileParentDelegationForChild({
      redis: {} as never,
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      childRunId: 'child-3',
      reason: 'test:cancel',
    });

    expect(mockResumeParentOnChildComplete).toHaveBeenCalledWith(
      expect.anything(),
      'a0000000-0000-0000-0000-000000000001',
      'child-3',
      'FAILED',
      undefined,
      undefined,
      expect.objectContaining({
        code: 'SUBFLOW_CANCELLED',
        classification: 'cancelled',
      }),
    );
  });

  it('drops reconcile silently when parent is PAUSED+pauseReason=interrupted', async () => {
    mockGetSessionState
      .mockResolvedValueOnce({
        sessionId: 'child-int',
        parentSessionId: 'parent-int',
        parentStepExecutionId: 'step-int',
        status: 'CANCELLED',
      })
      .mockResolvedValueOnce({
        sessionId: 'parent-int',
        status: 'PAUSED',
        pauseReason: 'interrupted',
        waitingForChildSessionIds: ['child-int'],
      });

    await reconcileParentDelegationForChild({
      redis: {} as never,
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      childRunId: 'child-int',
      reason: 'test:interrupted_parent',
    });

    expect(mockResumeParentOnChildComplete).not.toHaveBeenCalled();
    expect(mockBubbleChildPauseToParent).not.toHaveBeenCalled();
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
  });

  it('still reconciles a non-interrupted PAUSED parent (only interrupted state is gated)', async () => {
    mockGetSessionState
      .mockResolvedValueOnce({
        sessionId: 'child-pi',
        parentSessionId: 'parent-pi',
        parentStepExecutionId: 'step-pi',
        status: 'CANCELLED',
      })
      .mockResolvedValueOnce({
        sessionId: 'parent-pi',
        status: 'PAUSED',
        pauseReason: 'input_required',
        delegationPauseSource: 'child_input',
        pausedChildSessionId: 'child-pi',
        waitingForChildSessionIds: ['child-pi'],
      });

    await reconcileParentDelegationForChild({
      redis: {} as never,
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      childRunId: 'child-pi',
      reason: 'test:non_interrupted_paused_parent',
    });

    expect(mockResumeParentOnChildComplete).toHaveBeenCalled();
  });
});
