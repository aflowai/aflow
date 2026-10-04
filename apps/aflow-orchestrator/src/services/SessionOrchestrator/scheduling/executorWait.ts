/**
 * A missing executor is a wait, not a failure (Plan 315 D21).
 *
 * An executor's heartbeat lapses whenever its machine sleeps, restarts or has
 * not yet ticked, and every executor on a machine that slept is missing at once
 * until its first beat. Failing work on that reading failed every conversation
 * in flight across a night's sleep. So a step or a workflow operation task whose
 * executor is missing is parked on its shard timer, `executor_wait`, carrying
 * the job whole, and looked at again with a growing gap until its executor is
 * back or `EXECUTOR_WAIT_WINDOW_MS` has passed — and only then fails, as the
 * transient, retryable outage it is.
 *
 * The window and the gap are also what keep a lane that is down from becoming
 * a retry herd: nothing enters a retry budget while it waits, and what fails at
 * the window's end fails at its own time, a window after it was dispatched.
 */
import type { Redis } from 'ioredis';
import type { AflowError, StepJobMessage, StepResultMessage, TimerItem } from '@aflow/schemas';
import {
  addStepJob,
  executorWaitExpired,
  executorWaitNextLookAtMs,
  NoExecutorAvailableError,
  scheduleShardTimer,
  updateStepState,
} from '@aflow/redis';

const MS_PER_MINUTE = 60_000;

export type FirstDispatch =
  { kind: 'enqueued' } | { kind: 'waiting'; sinceMs: number; nextLookAtMs: number };

export type ExecutorDispatch = FirstDispatch | { kind: 'gave_up'; failure: AflowError };

/**
 * Enqueue `job`, or park it on its executor when none has a heartbeat.
 * Anything but a missing executor — a lane breaker's refusal among them — is
 * thrown as `addStepJob` threw it.
 */
export async function dispatchOrWaitOnExecutor(
  redis: Redis,
  job: StepJobMessage,
  nowMs: number = Date.now(),
): Promise<FirstDispatch> {
  try {
    await addStepJob(redis, job);
    return { kind: 'enqueued' };
  } catch (error) {
    if (!(error instanceof NoExecutorAvailableError)) throw error;
    return await park(redis, job, nowMs, nowMs);
  }
}

/**
 * Look again for the executor of a job parked since `sinceMs`: enqueue it,
 * park it until the next look, or give up once the window has passed.
 */
export async function lookAgainForExecutor(
  redis: Redis,
  job: StepJobMessage,
  sinceMs: number,
  nowMs: number = Date.now(),
): Promise<ExecutorDispatch> {
  const { sessionId } = job;
  if (sessionId !== undefined) {
    // Before the enqueue rather than after: once the job is in its stream the
    // executor owns the step's status, and a write after it could put a step
    // it has started back to SCHEDULED. A step that gives up below keeps no
    // mark of the wait, and one still waiting is marked again.
    await updateStepState(redis, job.tenantId, job.stepExecutionId, {
      sessionId,
      status: 'SCHEDULED',
      scheduledAt: nowMs,
      executorWaitSince: undefined,
    });
  }
  try {
    await addStepJob(redis, job);
    return { kind: 'enqueued' };
  } catch (error) {
    if (!(error instanceof NoExecutorAvailableError)) throw error;
    if (executorWaitExpired(sinceMs, nowMs)) {
      return { kind: 'gave_up', failure: executorWaitFailure(error, sinceMs, nowMs) };
    }
    return await park(redis, job, sinceMs, nowMs);
  }
}

async function park(
  redis: Redis,
  job: StepJobMessage,
  sinceMs: number,
  nowMs: number,
): Promise<FirstDispatch> {
  const nextLookAtMs = executorWaitNextLookAtMs(sinceMs, nowMs);
  if (job.sessionId !== undefined) {
    await updateStepState(redis, job.tenantId, job.stepExecutionId, {
      sessionId: job.sessionId,
      status: 'SCHEDULED',
      executorWaitSince: sinceMs,
    });
  }
  // Upserted under the timer's own id, so a look that finds the executor
  // still missing re-arms the claimed timer rather than adding a second.
  await scheduleShardTimer(redis, executorWaitTimer(job, sinceMs, nextLookAtMs));
  return { kind: 'waiting', sinceMs, nextLookAtMs };
}

export function executorWaitFailure(
  error: NoExecutorAvailableError,
  sinceMs: number,
  nowMs: number,
): AflowError {
  const minutes = Math.round((nowMs - sinceMs) / MS_PER_MINUTE);
  return {
    ...error.toAflowError(),
    message:
      `${error.message} Waited ${String(minutes)} minute${minutes === 1 ? '' : 's'} for it to ` +
      'come back; nothing was attempted.',
    timestamp: new Date(nowMs).toISOString(),
  };
}

/** The FAILED result for a job that waited out its window, or was refused. */
export function failedDispatchResult(
  job: StepJobMessage,
  failure: AflowError,
  nowMs: number,
): StepResultMessage {
  const error = {
    code: failure.code,
    message: failure.message,
    classification: failure.classification,
    retryable: failure.retryable,
    timestamp: failure.timestamp,
  };
  return {
    messageVersion: 1,
    tenantId: job.tenantId,
    ...(job.sessionId !== undefined ? { sessionId: job.sessionId } : {}),
    ...(job.workflowExecution !== undefined ? { workflowExecution: job.workflowExecution } : {}),
    stepExecutionId: job.stepExecutionId,
    parentStepExecutionId: job.parentStepExecutionId ?? null,
    stepId: job.stepId,
    stepType: job.stepType,
    operationId: job.operationId,
    attempt: job.attempt,
    idempotencyKey: job.idempotencyKey,
    status: 'FAILED',
    errorRef: `inline:${Buffer.from(JSON.stringify(error)).toString('base64')}`,
    error,
    traceId: job.traceId,
    finishedAtMs: nowMs,
  };
}

function executorWaitTimer(job: StepJobMessage, sinceMs: number, dueAtMs: number): TimerItem {
  return {
    tenantId: job.tenantId,
    ...(job.sessionId !== undefined ? { sessionId: job.sessionId } : {}),
    ...(job.workflowExecution !== undefined ? { workflowExecution: job.workflowExecution } : {}),
    stepExecutionId: job.stepExecutionId,
    stepId: job.stepId,
    operationId: job.operationId,
    stepType: job.stepType,
    reason: 'executor_wait',
    attempt: job.attempt,
    inputRef: job.inputRef,
    traceId: job.traceId,
    dueAtMs,
    ...(job.parentStepExecutionId != null
      ? { parentStepExecutionId: job.parentStepExecutionId }
      : {}),
    ...(job.credentialOwnerId !== undefined ? { credentialOwnerId: job.credentialOwnerId } : {}),
    ...(job.spaceId !== undefined ? { spaceId: job.spaceId } : {}),
    executorWait: { sinceMs, job },
  };
}
