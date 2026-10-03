import type { Redis } from 'ioredis';
import type { StepHotState } from '@aflow/redis';
import {
  STEP_DEADLINE_BACKSTOP_MS,
  STEP_STARTED_DEAD_EXECUTOR_GRACE_MS,
  STEP_SCHEDULED_STALL_GRACE_MS,
  STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS,
} from '@aflow/redis';
import type { StepType } from '@aflow/schemas';
import { SNOOZE_OPERATION_ID, getSnoozeMaxMs } from '@aflow/schemas';

export interface StepInFlightStatus {
  alive: boolean;
  deadlineAtMs: number | null;
}

export interface StepCompletionPathDeps {
  redis: Redis;
  getStepInFlight: (redis: Redis, stepExecutionId: string) => Promise<StepInFlightStatus>;
  hasAvailableExecutor: (redis: Redis, stepType: StepType) => Promise<boolean>;
}

export interface StepCompletionPath {
  /**
   * True when the current step still has a live completion authority: a STARTED
   * step whose executor is in-flight within its deadline+backstop, a SCHEDULED
   * step an executor has claimed, or a SCHEDULED step still inside its pickup
   * grace (plus the full snooze window for
   * the snooze op — its timer IS the completion path). Elapsed wall-clock age
   * alone is never evidence of failure.
   */
  hasCompletionPath: boolean;
  isStarted: boolean;
  /** STARTED → executor in-flight; SCHEDULED → in-flight, or an executor for the type is available. */
  executorOwnsStep: boolean;
  /** The in-flight key's own deadline (STARTED only); null otherwise. */
  stepDeadlineAtMs: number | null;
}

/**
 * THE single authority for "does this STARTED/SCHEDULED step still have a live
 * completion path?", shared by the stall watchdog (`timers.ts`), orphan recovery
 * (`isRescuableOrphan` → `recovery.ts`), and the parallel-barrier sweep so the
 * three cannot drift (Plan 230 §0). The caller is responsible for first
 * establishing that the session is RUNNING and the step is STARTED/SCHEDULED.
 *
 * A STARTED step is owned by an executor that refreshes a per-step in-flight key
 * for as long as it holds the step; a live key means the op is genuinely running
 * (healthy until its own `deadlineAtMs` + backstop margin). A SCHEDULED step with
 * a live key is claimed and waiting for its operation's slot, and is healthy for
 * as long as the key is. One with none has no owner yet, so it falls back to
 * process-level executor availability plus a pickup grace; the snooze op
 * additionally gets the full snooze window because a long snooze is a healthy
 * timer-wait, not a stall.
 */
export async function classifyStepCompletionPath(
  deps: StepCompletionPathDeps,
  stepState: StepHotState,
  now: number,
): Promise<StepCompletionPath> {
  const isStarted = stepState.status === 'STARTED';
  const ageMs = isStarted
    ? now - (stepState.startedAt ?? stepState.scheduledAt)
    : now - stepState.scheduledAt;
  const snoozeWindowMs = stepState.operationId === SNOOZE_OPERATION_ID ? getSnoozeMaxMs() : 0;

  const inflight = await deps.getStepInFlight(deps.redis, stepState.stepExecutionId);
  let executorOwnsStep: boolean;
  let stepDeadlineAtMs: number | null = null;
  if (isStarted) {
    executorOwnsStep = inflight.alive;
    stepDeadlineAtMs = inflight.deadlineAtMs;
  } else {
    executorOwnsStep =
      inflight.alive ||
      (await deps.hasAvailableExecutor(deps.redis, stepState.stepType as StepType));
  }

  let hasCompletionPath: boolean;
  if (!isStarted && inflight.alive) {
    // Claimed and waiting for its operation's slot: the executor marks it
    // STARTED only once admitted, and refreshes this record while it waits.
    hasCompletionPath = true;
  } else if (isStarted) {
    if (executorOwnsStep) {
      hasCompletionPath =
        stepDeadlineAtMs === null || now <= stepDeadlineAtMs + STEP_DEADLINE_BACKSTOP_MS;
    } else {
      hasCompletionPath = ageMs < STEP_STARTED_DEAD_EXECUTOR_GRACE_MS;
    }
  } else {
    const graceMs = executorOwnsStep
      ? STEP_SCHEDULED_STALL_GRACE_MS
      : STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS;
    hasCompletionPath = ageMs < graceMs + snoozeWindowMs;
  }

  return { hasCompletionPath, isStarted, executorOwnsStep, stepDeadlineAtMs };
}
