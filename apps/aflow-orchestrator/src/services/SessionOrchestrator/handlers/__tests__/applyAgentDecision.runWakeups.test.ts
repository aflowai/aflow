import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition, SessionAgentTarget, StepExecutionId } from '@aflow/schemas';

vi.mock('@aflow/redis', async () => ({
  ...(await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis')),
  atomicCompleteStep: vi.fn(),
  updateSessionState: vi.fn(),
  getSessionState: vi.fn(),
  registerBarrierWatchdog: vi.fn().mockResolvedValue(undefined),
}));

const mockWaitForInput = vi.fn();
vi.mock('../../../StepService/index.js', () => ({
  waitForInput: (...args: unknown[]) => mockWaitForInput(...args),
  completeStep: vi.fn(),
  failStep: vi.fn(),
}));

vi.mock('../../helpers/recoveryEmitter.js', () => ({
  buildStepCompletedRecoveryEvents: vi.fn().mockResolvedValue([]),
}));

vi.mock('../forwardChildEvent.js', () => ({
  forwardEventToParent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../cybernetic/WorkflowRunHarness.js', () => ({
  routeRunnerTerminalToHarness: vi.fn().mockResolvedValue(undefined),
}));

const mockWakeSessionForRunWakeups = vi.fn();
vi.mock('../../../cybernetic/harness/sessionWakeup.js', () => ({
  wakeSessionForRunWakeups: (...args: unknown[]) => mockWakeSessionForRunWakeups(...args),
}));

const { applyAgentDecision } = await import('../applyAgentDecision.js');

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SESSION_ID = '99999999-2222-3333-4444-555555555555';
const STEP_EXEC_ID = 'sex-1' as StepExecutionId;
const NOW = 1_700_000_000_000;

const helmsmanLike = {
  flowId: 'cybernetic-helmsman',
  schemaVersion: 1,
  metadata: { name: 'Helmsman', tags: ['system'] },
  stateVariables: [],
  startStepId: 'chat',
  steps: [
    {
      stepId: 'chat',
      stepType: 'ai',
      operation: 'ai.agent.turn',
      name: 'Helmsman',
      config: { agentRole: 'assistant', completionPolicy: 'open_ended' },
      tags: [],
      optional: false,
      onSuccess: { next: [] },
      onFailure: { next: [] },
    },
  ],
} as unknown as AgentDefinition;

function makeParams(decision: Record<string, unknown>) {
  const outputRef = `inline:${Buffer.from(
    JSON.stringify({
      decision,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: 'test-model',
      turnNumber: 2,
    }),
  ).toString('base64')}`;
  const runtimeState = { schemaVersion: 1 as const, variables: {}, version: 0, updatedAtMs: NOW };
  const payloadStore = {
    store: vi.fn(async () => 'mem:1'),
    retrieve: vi.fn(async (ref: string) =>
      JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')),
    ),
  };
  const deps = { db: {} as never, redis: {} as never, payloadStore: payloadStore as never };
  return {
    deps,
    params: {
      ...deps,
      result: {
        tenantId: TENANT,
        sessionId: SESSION_ID,
        stepId: 'chat',
        stepExecutionId: STEP_EXEC_ID,
        stepType: 'ai',
        operationId: 'ai.agent.turn',
        attempt: 1,
        outputRef,
        traceId: 'trace-1',
        nowMs: NOW,
      },
      runHotState: {
        sessionId: SESSION_ID,
        status: 'RUNNING',
        target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' } as SessionAgentTarget,
        runtimeState,
      } as never,
      stepDef: helmsmanLike.steps[0],
      stepState: { stepId: 'chat', stepExecutionId: STEP_EXEC_ID, startedAt: NOW } as never,
      agentDef: helmsmanLike,
      stepUpdates: {
        stepExecutionId: STEP_EXEC_ID,
        status: 'SUCCEEDED' as const,
        endedAt: NOW,
        outputRef,
      },
      currentRuntimeState: runtimeState,
      scheduleStep: vi.fn(),
    },
  };
}

beforeEach(() => {
  mockWaitForInput.mockReset().mockResolvedValue(undefined);
  mockWakeSessionForRunWakeups.mockReset().mockResolvedValue('read');
});

describe('a turn settling into user_input', () => {
  it('wakes the session for wakeups that landed while it ran, once it rests', async () => {
    const { params, deps } = makeParams({
      action: 'pause_for_input',
      message: 'The run is going; I will tell you when it reports.',
    });

    await expect(applyAgentDecision(params as never)).resolves.toBe(true);

    expect(mockWakeSessionForRunWakeups).toHaveBeenCalledOnce();
    expect(mockWakeSessionForRunWakeups).toHaveBeenCalledWith(deps, TENANT, SESSION_ID);
    expect(mockWaitForInput.mock.invocationCallOrder[0]!).toBeLessThan(
      mockWakeSessionForRunWakeups.mock.invocationCallOrder[0]!,
    );
  });

  it('settles the turn even when the wake cannot be delivered', async () => {
    mockWakeSessionForRunWakeups.mockRejectedValueOnce(new Error('redis unavailable'));
    const { params } = makeParams({ action: 'pause_for_input', message: 'Anything else?' });

    await expect(applyAgentDecision(params as never)).resolves.toBe(true);
    expect(mockWaitForInput).toHaveBeenCalledOnce();
  });
});
