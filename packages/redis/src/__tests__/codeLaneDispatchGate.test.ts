import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import {
  CodeLaneDisabledError,
  CODE_LANE_ENABLED_ENV,
  toAgentToolError,
  type StepJobMessage,
} from '@aflow/schemas';

import { addStepJob } from '../streams/jobs.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const SESSION_ID = '00000000-0000-0000-0000-0000000000b1';
const STEP_EXECUTION_ID = '00000000-0000-0000-0000-0000000000c1';
const SPACE_ID = '00000000-0000-0000-0000-0000000000aa';

function codeJob(operationId: string): StepJobMessage {
  return {
    messageVersion: 1,
    tenantId: TENANT_ID,
    sessionId: SESSION_ID,
    stepExecutionId: STEP_EXECUTION_ID,
    stepId: 'implement',
    stepType: 'code',
    operationId,
    attempt: 1,
    idempotencyKey: `${SESSION_ID}:${STEP_EXECUTION_ID}:1`,
    inputRef: 'inline:e30=',
    traceId: '0af7651916cd43dd8448eb211c80319c',
    scheduledAtMs: Date.now(),
    spaceId: SPACE_ID,
  } as StepJobMessage;
}

function fakeRedis() {
  // The enqueue is a pipeline (XADD plus the retention arm), so the pipeline's
  // XADD routes through the same spy — "nothing was written" keeps meaning
  // exactly that, whichever form the producer uses.
  const xadd = vi.fn().mockResolvedValue('1-0');
  const sadd = vi.fn();
  const chain = {
    xadd: (...args: unknown[]) => {
      xadd(...args);
      return chain;
    },
    sadd: (...args: unknown[]) => {
      sadd(...args);
      return chain;
    },
    exec: () => Promise.resolve([[null, '1-0']]),
  };
  return {
    xadd,
    sadd,
    pipeline: () => chain,
    get: vi.fn().mockResolvedValue(`consumer:${String(Date.now())}`),
    keys: vi.fn().mockResolvedValue([]),
  } as unknown as Redis & { xadd: ReturnType<typeof vi.fn>; sadd: ReturnType<typeof vi.fn> };
}

describe('addStepJob — coding-lane dispatch gate', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a code job when the breaker was never set', async () => {
    vi.stubEnv(CODE_LANE_ENABLED_ENV, undefined);
    const redis = fakeRedis();

    await expect(addStepJob(redis, codeJob('code.agent.run'))).rejects.toBeInstanceOf(
      CodeLaneDisabledError,
    );
    // The point of gating here rather than at the consumer: nothing is written,
    // so no job sits in `aflow:jobs:code` waiting for a host that never comes.
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(redis.sadd).not.toHaveBeenCalled();
  });

  it('refuses a code job when the breaker is explicitly false', async () => {
    vi.stubEnv(CODE_LANE_ENABLED_ENV, 'false');
    const redis = fakeRedis();

    await expect(addStepJob(redis, codeJob('code.repo.push'))).rejects.toBeInstanceOf(
      CodeLaneDisabledError,
    );
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('refuses every code operation, not just the harness run', async () => {
    vi.stubEnv(CODE_LANE_ENABLED_ENV, 'false');
    for (const operationId of [
      'code.agent.run',
      'code.agent.review',
      'code.repo.push',
      'code.repo.describe',
    ]) {
      const redis = fakeRedis();
      await expect(addStepJob(redis, codeJob(operationId))).rejects.toBeInstanceOf(
        CodeLaneDisabledError,
      );
      expect(redis.xadd).not.toHaveBeenCalled();
    }
  });

  it('refuses before the executor-availability check, so a live lane host cannot mask it', async () => {
    vi.stubEnv(CODE_LANE_ENABLED_ENV, 'false');
    const redis = fakeRedis();

    await expect(
      addStepJob(redis, codeJob('code.agent.run'), { checkExecutorAvailable: false }),
    ).rejects.toBeInstanceOf(CodeLaneDisabledError);
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('classifies the refusal as a non-retryable permission error', async () => {
    vi.stubEnv(CODE_LANE_ENABLED_ENV, 'false');
    const redis = fakeRedis();

    const error = await addStepJob(redis, codeJob('code.agent.run')).catch(
      (err: unknown) => err as CodeLaneDisabledError,
    );

    const aflowError = error.toAflowError();
    expect(aflowError.classification).toBe('permission');
    expect(aflowError.retryable).toBe(false);

    const agentError = toAgentToolError(aflowError);
    expect(agentError.error).toBe('permission');
    expect(agentError.retry).toBe(false);
  });

  it('enqueues a code job once an operator enabled the lane', async () => {
    vi.stubEnv(CODE_LANE_ENABLED_ENV, 'true');
    const redis = fakeRedis();

    await addStepJob(redis, codeJob('code.agent.run'), { checkExecutorAvailable: false });

    expect(redis.xadd).toHaveBeenCalledOnce();
    expect(redis.xadd.mock.calls[0]?.[0]).toBe('aflow:jobs:code');
    expect(redis.sadd.mock.calls[0]?.[1]).toBe('aflow:jobs:code');
  });

  it('leaves every other lane alone', async () => {
    vi.stubEnv(CODE_LANE_ENABLED_ENV, 'false');
    const redis = fakeRedis();

    await addStepJob(redis, { ...codeJob('ai.generate.text'), stepType: 'ai' } as StepJobMessage, {
      checkExecutorAvailable: false,
    });

    expect(redis.xadd).toHaveBeenCalledOnce();
    expect(redis.xadd.mock.calls[0]?.[0]).toBe('aflow:jobs:ai');
  });
});
