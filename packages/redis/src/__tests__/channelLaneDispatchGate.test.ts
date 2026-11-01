/**
 * Plan 327 D7: with the channel lane absent, a direct dispatch of a channel step
 * is refused as an uncomposed operation, and nothing else about dispatch moves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import {
  CHANNEL_REDIS_PASSWORD_ENV,
  ChannelLaneAbsentError,
  LANE_NOT_COMPOSED_CODE,
  LaneRefusalError,
  toAgentToolError,
  type StepJobMessage,
} from '@aflow/schemas';

import { addStepJob } from '../streams/jobs.js';
import { NoExecutorAvailableError } from '../streams/engineHealth.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const SESSION_ID = '00000000-0000-0000-0000-0000000000b1';
const STEP_EXECUTION_ID = '00000000-0000-0000-0000-0000000000c1';

function job(stepType: StepJobMessage['stepType'], operationId: string): StepJobMessage {
  return {
    messageVersion: 1,
    tenantId: TENANT_ID,
    sessionId: SESSION_ID,
    stepExecutionId: STEP_EXECUTION_ID,
    stepId: 'tell-the-operator',
    stepType,
    operationId,
    attempt: 1,
    idempotencyKey: `${SESSION_ID}:${STEP_EXECUTION_ID}:1`,
    inputRef: 'inline:e30=',
    traceId: '0af7651916cd43dd8448eb211c80319c',
    scheduledAtMs: Date.now(),
  } as StepJobMessage;
}

/** No executor of any lane has a heartbeat here. */
function fakeRedis() {
  const xadd = vi.fn().mockResolvedValue('1-0');
  const chain = {
    xadd: (...args: unknown[]) => {
      xadd(...args);
      return chain;
    },
    sadd: () => chain,
    exec: () => Promise.resolve([[null, '1-0']]),
  };
  return {
    xadd,
    pipeline: () => chain,
    keys: vi.fn().mockResolvedValue([]),
  } as unknown as Redis & { xadd: ReturnType<typeof vi.fn> };
}

describe('addStepJob — the channel lane', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses channel.message.send as an uncomposed operation where no channel credential is held', async () => {
    vi.stubEnv(CHANNEL_REDIS_PASSWORD_ENV, undefined);
    const redis = fakeRedis();

    const error = await addStepJob(redis, job('channel', 'channel.message.send')).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ChannelLaneAbsentError);
    expect(error).toBeInstanceOf(LaneRefusalError);
    const aflowError = (error as ChannelLaneAbsentError).toAflowError();
    expect(aflowError.code).toBe(LANE_NOT_COMPOSED_CODE);
    expect(aflowError.message).toContain('lane_not_composed');
    expect(aflowError.message).toContain('channel.message.send');
    expect(toAgentToolError(aflowError).retry).toBe(false);
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('refuses before the executor check, so a skipped check cannot let it through', async () => {
    vi.stubEnv(CHANNEL_REDIS_PASSWORD_ENV, '  ');
    const redis = fakeRedis();

    await expect(
      addStepJob(redis, job('channel', 'channel.message.send'), { checkExecutorAvailable: false }),
    ).rejects.toBeInstanceOf(ChannelLaneAbsentError);
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('parks a composed channel lane with no app online, as every lane parks', async () => {
    vi.stubEnv(CHANNEL_REDIS_PASSWORD_ENV, 'channel-credential');
    const redis = fakeRedis();

    await expect(addStepJob(redis, job('channel', 'channel.message.send'))).rejects.toBeInstanceOf(
      NoExecutorAvailableError,
    );
  });

  it('enqueues on aflow:jobs:channel once the lane is composed', async () => {
    vi.stubEnv(CHANNEL_REDIS_PASSWORD_ENV, 'channel-credential');
    const redis = fakeRedis();

    await addStepJob(redis, job('channel', 'channel.message.send'), {
      checkExecutorAvailable: false,
    });

    expect(redis.xadd.mock.calls[0]?.[0]).toBe('aflow:jobs:channel');
  });

  it.each([
    ['host', 'host.file.list'],
    ['browser', 'browser.page.open'],
  ] as const)(
    'leaves an absent %s lane parking, as it did before the channel lane existed',
    async (stepType, operationId) => {
      vi.stubEnv(CHANNEL_REDIS_PASSWORD_ENV, undefined);
      vi.stubEnv('PHOENIX_HOST_REDIS_PASSWORD', undefined);
      const redis = fakeRedis();

      await expect(addStepJob(redis, job(stepType, operationId))).rejects.toBeInstanceOf(
        NoExecutorAvailableError,
      );
    },
  );
});
