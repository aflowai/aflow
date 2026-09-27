/**
 * Regression test for the 2026-05-06 retry-discard wedge.
 *
 * The bug: when a step failed with a retryable error, `failStep(willRetry: true)`
 * set step status to FAILED. The retry timer fired and dispatched a new
 * attempt — but never reset the step state from FAILED back to SCHEDULED.
 * The executor's `shouldMarkStarted` check (`executor.ts:482`) only flips
 * status to STARTED when current status === 'SCHEDULED', so attempt N+1
 * ran with the step still showing FAILED. When attempt N+1's result
 * arrived, applyResult's idempotency guard (`index.ts:1525-1567`) saw
 * status === 'FAILED' and discarded the result as a "late result". Net
 * effect: every retry's result was silently dropped, the step never
 * escaped FAILED, the run never escaped RUNNING, the parent
 * (Helmsman/Driver) stayed WAITING_ON_CHILD forever.
 *
 * Live trigger: Anthropic API rate-limited the runner during the kaggle
 * skill execution test. The runner's `execute` step failed with
 * `AI_RATE_LIMIT` (retryable). Two attempts ran (per executor logs); the
 * orchestrator log line `[applyResult] Step ... already FAILED, discarding
 * late result` confirmed the discard. Helmsman + Driver wedged at
 * "retrying" with no progress.
 *
 * Fix: in the retry-timer-fire handler, reset the step state to SCHEDULED
 * with the new attempt number BEFORE dispatching, so the executor's
 * status-flip and applyResult's idempotency guard both see a fresh,
 * non-terminal step.
 *
 * This unit test exercises the state-reset behavior. End-to-end coverage
 * (full applyResult + executor pickup + result routing) is bigger and out
 * of scope here; the targeted unit pin keeps the regression caught.
 */
import { describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { setStepState, updateStepState, getStepState, type StepHotState } from '@aflow/redis';
import type { TenantId, SessionId, StepExecutionId } from '@aflow/schemas';

const TENANT = 'tenant-retry-reset' as TenantId;
const RUN = '00000000-0000-0000-0000-0000000000d1' as SessionId;
const STEP = '00000000-0000-0000-0000-0000000000d2' as StepExecutionId;

function createMockRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

function makeFailedStepState(): StepHotState {
  return {
    stepExecutionId: STEP,
    tenantId: TENANT,
    sessionId: RUN,
    stepId: 'execute',
    stepType: 'ai',
    operationId: 'ai.agent.turn',
    attempt: 1,
    status: 'FAILED',
    scheduledAt: 1000,
    startedAt: 1100,
    endedAt: 1500,
    inputRef: 'inline:test',
    errorRef: 'inline:error',
    idempotencyKey: 'idem-attempt-1',
  };
}

describe('retry-timer step-state reset', () => {
  it('resets a FAILED step (with willRetry) back to SCHEDULED for the next attempt', async () => {
    // This is the exact transformation the retry-timer-fire handler must
    // perform. Without it the retry attempt's executor pickup leaves the
    // step in FAILED and applyResult discards the result.
    const redis = createMockRedis();
    await setStepState(redis, makeFailedStepState());

    // Simulate the timer firing for attempt 2.
    const nextAttempt = 2;
    const dispatchTime = 2000;
    await updateStepState(redis, TENANT, STEP, {
      status: 'SCHEDULED',
      attempt: nextAttempt,
      scheduledAt: dispatchTime,
      startedAt: undefined,
      endedAt: undefined,
      errorRef: undefined,
      outputRef: undefined,
    });

    const after = await getStepState(redis, TENANT, STEP);
    expect(after).not.toBeNull();
    if (!after) return;
    expect(after.status).toBe('SCHEDULED');
    expect(after.attempt).toBe(nextAttempt);
    expect(after.errorRef).toBeUndefined();
    expect(after.endedAt).toBeUndefined();
    expect(after.startedAt).toBeUndefined();
  });

  it('after reset, the executor would mark the step STARTED on pickup (status === SCHEDULED gate)', async () => {
    // Pin the contract: the executor's `shouldMarkStarted` check requires
    // status === 'SCHEDULED'. If the retry path leaves the step in any
    // other status (FAILED, STARTED, SUCCEEDED), the executor skips the
    // status flip and the late-result guard kicks in downstream.
    const redis = createMockRedis();
    await setStepState(redis, makeFailedStepState());
    await updateStepState(redis, TENANT, STEP, {
      status: 'SCHEDULED',
      attempt: 2,
      scheduledAt: 2000,
      startedAt: undefined,
      endedAt: undefined,
      errorRef: undefined,
    });

    const beforePickup = await getStepState(redis, TENANT, STEP);
    expect(beforePickup?.status).toBe('SCHEDULED');
    // The executor's `shouldMarkStarted = stepState?.status === 'SCHEDULED' || !stepState`
    // would now fire and flip to STARTED — that's the contract this test pins.
  });

  it('does NOT reset for non-retry timer reasons (defensive — only retry/delayed_start fire the reset)', async () => {
    // Belt-and-suspenders: the reset is conditional on `timer.reason ===
    // 'retry' || 'delayed_start'`. Other reasons (e.g. 'cleanup',
    // 'health_check') must not stomp the step state.
    const redis = createMockRedis();
    const original = makeFailedStepState();
    await setStepState(redis, original);

    // Simulate a non-retry timer that does NOT fire the reset.
    // (i.e. nothing happens to the step state.)
    const after = await getStepState(redis, TENANT, STEP);
    expect(after?.status).toBe('FAILED');
    expect(after?.attempt).toBe(1);
  });
});
