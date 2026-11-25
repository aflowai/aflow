/**
 * Contract: an unattended agent turn that failed on malformed arguments gets
 * one fresh attempt, and only where the step's retry policy allows another
 * attempt. The step and session hot state, the shard timers and the step
 * service are stand-ins, so the assertions read which way applyResult routed
 * the failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StepResultMessage } from '@aflow/schemas';

const fake = vi.hoisted(() => ({
  stepDef: null as Record<string, unknown> | null,
}));

vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/redis')>();
  return {
    ...actual,
    isSessionCorrupt: vi.fn(() => Promise.resolve(false)),
    getStepState: vi.fn(() =>
      Promise.resolve({
        stepExecutionId: STEP_EXEC,
        status: 'STARTED',
        attempt: 1,
        inputRef: 'inline:e30=',
      }),
    ),
    getSessionStateSafe: vi.fn(() =>
      Promise.resolve({
        ok: true,
        state: { sessionId: SESSION, tenantId: TENANT, status: 'RUNNING', target: {} },
      }),
    ),
    scheduleShardTimer: vi.fn(() => Promise.resolve()),
    markRunInactive: vi.fn(() => Promise.resolve()),
    markSessionDirty: vi.fn(() => Promise.resolve()),
    updateSessionState: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../../helpers/fetchAgentDef.js', () => ({
  fetchAgentDef: vi.fn(() =>
    Promise.resolve({ flowId: 'flow', version: '1', steps: fake.stepDef ? [fake.stepDef] : [] }),
  ),
}));

vi.mock('../../handlers/agentDecisionRecovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../handlers/agentDecisionRecovery.js')>();
  // An unattended turn: the guided in-turn recovery does not handle it.
  return { ...actual, recoverFailedAgentDecision: vi.fn(() => Promise.resolve(false)) };
});

vi.mock('../../../StepService/index.js', () => ({
  failStep: vi.fn(() => Promise.resolve()),
  waitForInput: vi.fn(() => Promise.resolve()),
}));

import { scheduleShardTimer } from '@aflow/redis';
import { failStep } from '../../../StepService/index.js';
import type { SessionOrchestratorBindings } from '../../lifecycle/context.js';
import { createApplyResult } from '../applyResult.js';

const TENANT = '11111111-1111-4111-9111-111111111111';
const SESSION = '33333333-3333-4333-9333-333333333333';
const STEP_EXEC = '44444444-4444-4444-9444-444444444444';

function turnDef(retryPolicy?: Record<string, unknown>): Record<string, unknown> {
  return {
    stepId: 'agent',
    stepType: 'ai',
    operation: 'ai.agent.turn',
    name: 'Agent',
    config: {},
    tags: [],
    optional: false,
    onSuccess: { next: [] },
    onFailure: { next: [] },
    ...(retryPolicy ? { retryPolicy } : {}),
  };
}

const ONE_ATTEMPT = {
  maxAttempts: 1,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffStrategy: 'exponential',
  backoffMultiplier: 2,
  jitterFraction: 0.1,
  retryableErrorCodes: [],
  retryableClassifications: ['timeout', 'rate_limit', 'provider', 'transient'],
};

function malformedFailure(attempt: number): StepResultMessage {
  return {
    messageVersion: 1,
    tenantId: TENANT,
    sessionId: SESSION,
    stepExecutionId: STEP_EXEC,
    stepId: 'agent',
    stepType: 'ai',
    operationId: 'ai.agent.turn',
    attempt,
    idempotencyKey: `idem-${String(attempt)}`,
    status: 'FAILED',
    traceId: 'trace-1',
    error: {
      code: 'AGENT_DECISION_INVALID',
      message: 'Agent tool "draft_patch" arguments invalid: /operations: must be array',
      classification: 'validation',
      retryable: false,
      details: { reason: '/operations: must be array', malformedArguments: true },
    },
  } as unknown as StepResultMessage;
}

function applyResult() {
  const bindings = {
    deps: { redis: {} as never, payloadStore: {} as never, consumerName: 'test', db: {} as never },
    harnessDeps: {} as never,
    scheduleStep: vi.fn(),
    failRunWithCleanup: vi.fn(() => Promise.resolve()),
  } as unknown as SessionOrchestratorBindings;
  return { run: createApplyResult(bindings), bindings };
}

function retryTimers() {
  return vi
    .mocked(scheduleShardTimer)
    .mock.calls.map(([, timer]) => timer)
    .filter((timer) => timer.reason === 'retry');
}

function retriedFailures() {
  return vi
    .mocked(failStep)
    .mock.calls.filter(([, , , opts]) => (opts as { willRetry?: boolean }).willRetry === true);
}

describe('applyResult — a malformed-arguments failure on an unattended turn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.stepDef = null;
  });

  it('retries once on a fresh attempt where the retry policy allows another', async () => {
    fake.stepDef = turnDef();
    const { run } = applyResult();
    await run({ result: malformedFailure(1), messageId: '1-0' });

    expect(retriedFailures()).toHaveLength(1);
    expect(retryTimers()).toEqual([expect.objectContaining({ attempt: 2, stepId: 'agent' })]);
  });

  it('fails the turn on the second attempt', async () => {
    fake.stepDef = turnDef();
    const { run } = applyResult();
    await run({ result: malformedFailure(2), messageId: '1-0' });

    expect(retryTimers()).toEqual([]);
    expect(retriedFailures()).toEqual([]);
    expect(failStep).toHaveBeenCalled();
  });

  it('does not retry a turn whose retry policy allows one attempt', async () => {
    fake.stepDef = turnDef(ONE_ATTEMPT);
    const { run } = applyResult();
    await run({ result: malformedFailure(1), messageId: '1-0' });

    expect(retryTimers()).toEqual([]);
    expect(retriedFailures()).toEqual([]);
    expect(failStep).toHaveBeenCalled();
  });
});
