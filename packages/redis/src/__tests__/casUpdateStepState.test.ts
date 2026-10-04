/**
 * A step write decided from a read of the step lands only while the step is
 * still what was read: `casUpdateStepState` compares status and attempt and
 * writes in one script, so a cancel, retry or result landing in between is
 * kept, and the stall candidate is armed only by a write that lands.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

import { sessionCandidateMember } from '../hotState/candidateMember.js';
import { casUpdateStepState, getStepState, setStepState } from '../hotState/step.js';
import { stepStallEarliestReapAtMs } from '../hotState/stepStallCandidates.js';
import type { StepHotState } from '../hotState/schemas.js';

const TENANT = '11111111-1111-4111-9111-111111111111';
const SESSION = '33333333-3333-4333-9333-333333333333';
const STEP = '44444444-4444-4444-9444-000000000001';
const SCHEDULED_AT_MS = Date.UTC(2026, 9, 4, 2, 0, 0);
const LOOKED_AT_MS = SCHEDULED_AT_MS + 20_000;

function scheduledStep(overrides: Partial<StepHotState> = {}): StepHotState {
  return {
    stepExecutionId: STEP,
    tenantId: TENANT,
    sessionId: SESSION,
    stepId: 'commission',
    stepType: 'host',
    operationId: 'host.harness.run',
    attempt: 1,
    status: 'SCHEDULED',
    scheduledAt: SCHEDULED_AT_MS,
    inputRef: 'inline:e30=',
    idempotencyKey: `${SESSION}:${STEP}:1`,
    ...overrides,
  };
}

async function stallScore(redis: RedisType): Promise<string | null> {
  return redis.zscore(StreamKeys.stepStallCandidatesKey, sessionCandidateMember(TENANT, SESSION));
}

describe('casUpdateStepState', () => {
  let redis: RedisType;
  beforeEach(async () => {
    redis = new Redis() as unknown as RedisType;
    await redis.flushall();
  });

  it('writes, removes the fields patched as undefined, and arms the stall candidate while the step holds the expected status and attempt', async () => {
    await setStepState(redis, scheduledStep({ errorRef: 'inline:e30=' }));
    await redis.zrem(StreamKeys.stepStallCandidatesKey, sessionCandidateMember(TENANT, SESSION));
    const patch = {
      sessionId: SESSION,
      status: 'SCHEDULED' as const,
      scheduledAt: LOOKED_AT_MS,
      errorRef: undefined,
    };

    const written = await casUpdateStepState(
      redis,
      TENANT,
      STEP,
      { status: 'SCHEDULED', attempt: 1 },
      patch,
    );

    expect(written).toBe(true);
    const step = await getStepState(redis, TENANT, STEP);
    expect(step).toMatchObject({ status: 'SCHEDULED', attempt: 1, scheduledAt: LOOKED_AT_MS });
    expect(step?.errorRef).toBeUndefined();
    expect(Number(await stallScore(redis))).toBe(stepStallEarliestReapAtMs(patch, Date.now()));
  });

  it.each([
    ['cancelled', { status: 'CANCELLED' as const, endedAt: LOOKED_AT_MS }],
    ['retried', { attempt: 2 }],
  ])('refuses, writing nothing, on a step %s since it was read', async (_label, movedOn) => {
    await setStepState(redis, scheduledStep(movedOn));
    await redis.zrem(StreamKeys.stepStallCandidatesKey, sessionCandidateMember(TENANT, SESSION));
    const before = await getStepState(redis, TENANT, STEP);

    const written = await casUpdateStepState(
      redis,
      TENANT,
      STEP,
      { status: 'SCHEDULED', attempt: 1 },
      { sessionId: SESSION, status: 'SCHEDULED', scheduledAt: LOOKED_AT_MS },
    );

    expect(written).toBe(false);
    expect(await getStepState(redis, TENANT, STEP)).toEqual(before);
    expect(await stallScore(redis)).toBeNull();
  });

  it('refuses a step whose hot state is gone, rather than creating one', async () => {
    const written = await casUpdateStepState(
      redis,
      TENANT,
      STEP,
      { status: 'SCHEDULED', attempt: 1 },
      { sessionId: SESSION, status: 'SCHEDULED', scheduledAt: LOOKED_AT_MS },
    );

    expect(written).toBe(false);
    expect(await getStepState(redis, TENANT, STEP)).toBeNull();
  });
});
