import { describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { StepJobMessageSchema } from '@aflow/schemas';

import { getStepState, setStepState, updateStepState } from '../hotState/step.js';

const TENANT = '11111111-1111-4111-9111-111111111111';
const SESSION = '33333333-3333-4333-9333-333333333333';
const STEP = '44444444-4444-4444-9444-000000000001';
const PARKED_AT_MS = Date.UTC(2026, 9, 4, 2, 0, 0);

const job = StepJobMessageSchema.parse({
  tenantId: TENANT,
  sessionId: SESSION,
  stepExecutionId: STEP,
  parentStepExecutionId: null,
  stepId: 'commission',
  stepType: 'host',
  operationId: 'host.harness.run',
  attempt: 1,
  idempotencyKey: `${SESSION}:${STEP}:1`,
  inputRef: 'inline:e30=',
  traceId: 'trace-asleep',
  scheduledAtMs: PARKED_AT_MS,
  spaceId: '55555555-5555-4555-9555-555555555555',
  callerModel: 'luna',
});

describe('a step parked on its executor', () => {
  it('keeps the job it was parked with on its hot state, field for field, until the wait ends', async () => {
    const redis = new Redis() as unknown as RedisType;
    await setStepState(redis, {
      stepExecutionId: STEP,
      tenantId: TENANT,
      sessionId: SESSION,
      stepId: job.stepId,
      stepType: job.stepType,
      operationId: job.operationId,
      attempt: 1,
      status: 'SCHEDULED',
      scheduledAt: PARKED_AT_MS,
      inputRef: job.inputRef,
      idempotencyKey: job.idempotencyKey,
    });

    await updateStepState(redis, TENANT, STEP, {
      sessionId: SESSION,
      executorWait: { sinceMs: PARKED_AT_MS, job },
    });
    expect((await getStepState(redis, TENANT, STEP))?.executorWait).toEqual({
      sinceMs: PARKED_AT_MS,
      job,
    });

    await updateStepState(redis, TENANT, STEP, { sessionId: SESSION, executorWait: undefined });
    expect((await getStepState(redis, TENANT, STEP))?.executorWait).toBeUndefined();
  });
});
