/**
 * A failed step that spent money before it failed still spent it: the step's
 * usage rides the StepFailed event and counts toward the run's usage summary,
 * as a succeeded step's does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionHotState } from '@aflow/redis';
import type {
  SessionId,
  StepExecutionId,
  StepUsageBreakdown,
  TenantId,
  TraceId,
} from '@aflow/schemas';

const { atomicCompleteStep } = vi.hoisted(() => ({
  atomicCompleteStep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@aflow/redis', () => ({ atomicCompleteStep }));
vi.mock('../../SessionOrchestrator/helpers/recoveryEmitter.js', () => ({
  buildStepCompletedRecoveryEvents: vi.fn().mockResolvedValue([]),
  buildRunPausedAfterStepSucceededRecoveryEvents: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../SessionOrchestrator/handlers/forwardChildEvent.js', () => ({
  forwardEventToParent: vi.fn().mockResolvedValue(undefined),
}));

import { failStep } from '../StepService.js';

const usage: StepUsageBreakdown = {
  provider: 'google',
  model: 'gemini-test',
  promptTokens: 80,
  completionTokens: 120,
  totalTokens: 200,
  promptCostUsd: 0.1,
  completionCostUsd: 0.15,
  totalCostUsd: 0.25,
} as StepUsageBreakdown;

function ctx(runState: Partial<SessionHotState>) {
  return {
    tenantId: 'tenant-f' as TenantId,
    runId: 'run-f' as SessionId,
    agentDef: {} as never,
    traceId: 'trace-f' as TraceId,
    stepDef: { stepId: 'probe', stepType: 'ai', operation: 'ai.model.probe_reasoning' } as never,
    stepExecutionId: 'step-f' as StepExecutionId,
    attempt: 1,
    runState: runState as SessionHotState,
  };
}

function written() {
  const call = atomicCompleteStep.mock.calls[0] as unknown as [
    unknown,
    unknown,
    unknown,
    Partial<SessionHotState>,
    SessionEvent[],
  ];
  const stepFailed = call[4].find((e) => e.eventType === 'StepFailed');
  return { runUpdates: call[3], stepFailed };
}

describe('failStep usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries the spend on the StepFailed event and adds it to the run usage summary', async () => {
    const deps = { redis: {} as never, payloadStore: {} as never };
    await failStep(
      deps,
      ctx({
        usageSummary: {
          totalPromptTokens: 10,
          totalCompletionTokens: 20,
          totalTokens: 30,
          totalCostUsd: 0.5,
          models: ['other-model'],
        },
      }),
      { code: 'REASONING_PROBE_NOTHING_MEASURED', message: 'nothing measured' },
      { classification: 'content_policy', retryable: false, usage },
    );

    const { runUpdates, stepFailed } = written();
    expect(stepFailed?.usage).toEqual(usage);
    expect(stepFailed?.metadata).toMatchObject({ costJson: usage });
    expect(runUpdates.usageSummary).toEqual({
      totalPromptTokens: 90,
      totalCompletionTokens: 140,
      totalTokens: 230,
      totalCostUsd: 0.75,
      models: ['other-model', 'gemini-test'],
    });
  });

  it('leaves the run usage summary alone when the step spent nothing', async () => {
    const deps = { redis: {} as never, payloadStore: {} as never };
    await failStep(deps, ctx({}), { code: 'X', message: 'failed' });

    const { runUpdates, stepFailed } = written();
    expect(runUpdates).not.toHaveProperty('usageSummary');
    expect(stepFailed).not.toHaveProperty('usage');
  });
});
