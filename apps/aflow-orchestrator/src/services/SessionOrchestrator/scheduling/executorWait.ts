/**
 * A missing executor is a wait, not a failure (Plan 315 D21).
 *
 * The budget is counted in looks rather than in time because a sleeping machine
 * delivers no looks: a wait it sleeps through has spent nothing of it on waking.
 * A look that comes a heartbeat's lifetime or more after it was due is that
 * wake, when every executor is missing at once, so it counts for nothing and is
 * followed by one more before any can give up.
 */
import type { Redis } from 'ioredis';
import type {
  AflowError,
  IdempotencyKey,
  OperationId,
  SessionId,
  StepExecutionId,
  StepId,
  StepJobMessage,
  StepResultMessage,
  StepType,
  TenantId,
  TimerItem,
  TraceId,
} from '@aflow/schemas';
import type { SessionEvent, SessionHotState, StepHotState } from '@aflow/redis';
import {
  addStepJob,
  appendSessionEvent,
  EXECUTOR_WAIT_LONGEST_LOOK_MS,
  EXECUTOR_WAIT_LOOKS,
  executorSeenSinceStart,
  executorWaitClockJumped,
  executorWaitGapMs,
  NoExecutorAvailableError,
  scheduleShardTimer,
  updateStepState,
} from '@aflow/redis';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { forwardEventToParent } from '../handlers/forwardChildEvent.js';
import { generateEventId } from '../helpers/ids.js';

const MS_PER_MINUTE = 60_000;

export type FirstDispatch =
  { kind: 'enqueued' } | { kind: 'waiting'; sinceMs: number; nextLookAtMs: number };

export type ExecutorDispatch = FirstDispatch | { kind: 'gave_up'; failure: AflowError };

/** A parked job's wait, as its `executor_wait` timer carries it. */
export interface ExecutorWaitLook {
  sinceMs: number;
  /** Looks already taken, not counting the one being taken now. */
  looks: number;
  /** When the look being taken now was due. */
  dueAtMs: number;
}

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
    const parked = await park(redis, job, nowMs, 0, nowMs + executorWaitGapMs(0));
    await announceExecutorWait(redis, job, nowMs);
    return parked;
  }
}

/** Shows a session step as waiting for its executor rather than as an ordinary SCHEDULED. */
async function announceExecutorWait(
  redis: Redis,
  job: StepJobMessage,
  nowMs: number,
): Promise<void> {
  const { sessionId } = job;
  if (sessionId === undefined) return;
  const event: SessionEvent = {
    eventId: generateEventId(),
    eventType: 'StepWaitingOnExecutor',
    timestamp: nowMs,
    sessionId,
    stepId: job.stepId,
    stepExecutionId: job.stepExecutionId,
    stepType: job.stepType,
    attempt: job.attempt,
    metadata: { operationId: job.operationId, executorWaitLooks: EXECUTOR_WAIT_LOOKS },
  };
  await appendSessionEvent(redis, job.tenantId, sessionId, event);
  await forwardEventToParent(redis, job.tenantId, sessionId, event).catch((error: unknown) => {
    logOrchestratorError('[executorWait] Failed to forward the wait to the parent session', error, {
      tenantId: job.tenantId,
      sessionId,
      stepExecutionId: job.stepExecutionId,
    });
  });
}

/**
 * Look again for the executor of a parked job: enqueue it, park it until the
 * next look, or give up once its looks are spent. The step stays marked
 * waiting until its job is in its stream, so an enqueue that throws anything
 * but a missing executor leaves the timer's redelivery still this wait's to
 * dispatch.
 */
export async function lookAgainForExecutor(
  redis: Redis,
  job: StepJobMessage,
  wait: ExecutorWaitLook,
  nowMs: number = Date.now(),
): Promise<ExecutorDispatch> {
  const { sessionId } = job;
  if (sessionId !== undefined) {
    // The status is written before the enqueue rather than after: once the
    // job is in its stream the executor owns it, and a write after could put
    // a step it has started back to SCHEDULED.
    await updateStepState(redis, job.tenantId, job.stepExecutionId, {
      sessionId,
      status: 'SCHEDULED',
      scheduledAt: nowMs,
    });
  }
  try {
    await addStepJob(redis, job);
  } catch (error) {
    if (!(error instanceof NoExecutorAvailableError)) throw error;
    const { sinceMs } = wait;
    if (executorWaitClockJumped(wait.dueAtMs, nowMs)) {
      return await park(redis, job, sinceMs, wait.looks, nowMs + EXECUTOR_WAIT_LONGEST_LOOK_MS);
    }
    const looks = wait.looks + 1;
    if (looks >= EXECUTOR_WAIT_LOOKS) {
      // Unmarked before the failure is applied, so a step whose failure never
      // lands is left to the stall watchdog rather than re-armed as a wait.
      await endExecutorWait(redis, job);
      return {
        kind: 'gave_up',
        failure: executorWaitFailure(error, sinceMs, nowMs, executorSeenSinceStart(job.stepType)),
      };
    }
    return await park(redis, job, sinceMs, looks, nowMs + executorWaitGapMs(looks));
  }
  await endExecutorWait(redis, job);
  return { kind: 'enqueued' };
}

/**
 * Arm the wait again for a step still marked waiting whose timer is gone, so
 * it is looked for now rather than failed. The looks the lost timer had taken
 * went with it, so the wait starts its budget again from its marker. The job is
 * rebuilt from the step and its run as a retry rebuilds it: the caller's
 * model, which the step does not record, goes without.
 */
export async function rearmExecutorWait(
  redis: Redis,
  step: StepHotState,
  run: SessionHotState,
  nowMs: number = Date.now(),
): Promise<void> {
  const sinceMs = step.executorWaitSince;
  if (sinceMs === undefined) return;
  const sessionId = step.sessionId as SessionId;
  const stepExecutionId = step.stepExecutionId as StepExecutionId;
  const job: StepJobMessage = {
    messageVersion: 1,
    tenantId: step.tenantId as TenantId,
    sessionId,
    stepExecutionId,
    parentStepExecutionId: (step.parentStepExecutionId ?? null) as StepExecutionId | null,
    stepId: step.stepId as StepId,
    stepType: step.stepType as StepType,
    operationId: step.operationId as OperationId,
    attempt: step.attempt,
    idempotencyKey: `${sessionId}:${stepExecutionId}:${String(step.attempt)}` as IdempotencyKey,
    inputRef: step.inputRef,
    traceId: (step.traceId ?? run.traceId ?? crypto.randomUUID()) as TraceId,
    scheduledAtMs: nowMs,
    ...(run.createdBy !== undefined ? { credentialOwnerId: run.createdBy } : {}),
    ...(run.spaceId !== undefined ? { spaceId: run.spaceId } : {}),
  };
  await scheduleShardTimer(redis, executorWaitTimer(job, sinceMs, 0, nowMs));
}

/** Patched without a status, which the executor owns once the job is in its stream. */
async function endExecutorWait(redis: Redis, job: StepJobMessage): Promise<void> {
  if (job.sessionId === undefined) return;
  await updateStepState(redis, job.tenantId, job.stepExecutionId, {
    sessionId: job.sessionId,
    executorWaitSince: undefined,
  });
}

async function park(
  redis: Redis,
  job: StepJobMessage,
  sinceMs: number,
  looks: number,
  nextLookAtMs: number,
): Promise<FirstDispatch> {
  if (job.sessionId !== undefined) {
    await updateStepState(redis, job.tenantId, job.stepExecutionId, {
      sessionId: job.sessionId,
      status: 'SCHEDULED',
      executorWaitSince: sinceMs,
    });
  }
  // Upserted under the timer's own id, so a look that finds the executor
  // still missing re-arms the claimed timer rather than adding a second.
  await scheduleShardTimer(redis, executorWaitTimer(job, sinceMs, looks, nextLookAtMs));
  return { kind: 'waiting', sinceMs, nextLookAtMs };
}

/**
 * An executor this orchestrator has seen and lost is asleep or restarting, and
 * a retry may find it back. One it has never seen was never started, and a
 * retry would only wait for it again.
 */
export function executorWaitFailure(
  error: NoExecutorAvailableError,
  sinceMs: number,
  nowMs: number,
  executorSeen: boolean,
): AflowError {
  const minutes = Math.round((nowMs - sinceMs) / MS_PER_MINUTE);
  const waited = `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  const timestamp = new Date(nowMs).toISOString();
  if (executorSeen) {
    return {
      ...error.toAflowError(),
      message: `${error.message} Waited ${waited} for it to come back; nothing was attempted.`,
      timestamp,
    };
  }
  return {
    ...error.toAflowError(),
    message:
      `${error.message} None has connected since the orchestrator started, so it is not ` +
      `asleep but was never started. Waited ${waited}; nothing was attempted.`,
    classification: 'configuration',
    retryable: false,
    timestamp,
  };
}

/** The FAILED result for a job that spent its looks, or was refused. */
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

function executorWaitTimer(
  job: StepJobMessage,
  sinceMs: number,
  looks: number,
  dueAtMs: number,
): TimerItem {
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
    executorWait: { sinceMs, looks, job },
  };
}
