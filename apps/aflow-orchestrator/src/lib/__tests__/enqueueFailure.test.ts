import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import { CODE_LANE_ENABLED_ENV, toAgentToolError, type StepJobMessage } from '@aflow/schemas';
import { addStepJob, NoExecutorAvailableError } from '@aflow/redis';

import { describeEnqueueFailure, enqueueFailureResultError } from '../enqueueFailure.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const SESSION_ID = '00000000-0000-0000-0000-0000000000b1';
const STEP_EXECUTION_ID = '00000000-0000-0000-0000-0000000000c1';

const CODE_JOB = {
  messageVersion: 1,
  tenantId: TENANT_ID,
  sessionId: SESSION_ID,
  stepExecutionId: STEP_EXECUTION_ID,
  stepId: 'implement',
  stepType: 'code',
  operationId: 'code.agent.run',
  attempt: 1,
  idempotencyKey: `${SESSION_ID}:${STEP_EXECUTION_ID}:1`,
  inputRef: 'inline:e30=',
  traceId: '0af7651916cd43dd8448eb211c80319c',
  scheduledAtMs: Date.now(),
} as StepJobMessage;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('describeEnqueueFailure', () => {
  it('turns the real dispatch-gate throw into a non-retryable permission refusal', async () => {
    vi.stubEnv(CODE_LANE_ENABLED_ENV, 'false');
    const redis = { xadd: vi.fn() } as unknown as Redis;

    const thrown = await addStepJob(redis, CODE_JOB).catch((err: unknown) => err);
    const failure = describeEnqueueFailure(thrown);

    expect(failure.code).toBe('CODE_LANE_DISABLED');
    expect(failure.classification).toBe('permission');
    expect(failure.retryable).toBe(false);
  });

  it('keeps a missing executor a transient outage, not a refusal', () => {
    const failure = describeEnqueueFailure(new NoExecutorAvailableError('code'));
    expect(failure.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(failure.classification).toBe('transient');
    expect(failure.retryable).toBe(true);
  });

  it('treats anything else as an internal enqueue failure', () => {
    const failure = describeEnqueueFailure(new Error('connection closed'));
    expect(failure.code).toBe('ENQUEUE_FAILED');
    expect(failure.classification).toBe('internal');
    expect(failure.retryable).toBe(false);
  });
});

describe('enqueueFailureResultError', () => {
  it('carries the refusal all the way to the agent as permission + retry:false', async () => {
    vi.stubEnv(CODE_LANE_ENABLED_ENV, 'false');
    const redis = { xadd: vi.fn() } as unknown as Redis;

    const thrown = await addStepJob(redis, CODE_JOB).catch((err: unknown) => err);
    const resultError = enqueueFailureResultError(describeEnqueueFailure(thrown));

    // `applyResult` re-projects this durable field; an absent classification
    // would default to `internal`, which reads as a platform fault to wait out.
    expect(resultError.classification).toBe('permission');
    expect(resultError.retryable).toBe(false);

    const agentError = toAgentToolError({
      code: resultError.code,
      message: resultError.message,
      classification: resultError.classification ?? 'internal',
      retryable: false,
      timestamp: resultError.timestamp,
    });
    expect(agentError.error).toBe('permission');
    expect(agentError.retry).toBe(false);
  });

  it('carries a missing executor as the transient, retryable outage it is', () => {
    // It reaches here only after spending EXECUTOR_WAIT_LOOKS, so the
    // retry it enters is one step's, not a herd behind a lane that blinked.
    const resultError = enqueueFailureResultError(
      describeEnqueueFailure(new NoExecutorAvailableError('ai')),
    );
    expect(resultError.classification).toBe('transient');
    expect(resultError.retryable).toBe(true);
  });
});
