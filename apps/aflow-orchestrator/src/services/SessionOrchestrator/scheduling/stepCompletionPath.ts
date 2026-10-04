import type { Redis } from 'ioredis';
import type { StepHotState, TimerIdentity } from '@aflow/redis';
import {
  STEP_DEADLINE_BACKSTOP_MS,
  STEP_STARTED_DEAD_EXECUTOR_GRACE_MS,
  STEP_SCHEDULED_STALL_GRACE_MS,
  STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS,
  executorWaitHasLooksLeft,
} from '@aflow/redis';
import type { SessionId, StepExecutionId, StepType, TimerItem } from '@aflow/schemas';
import { SNOOZE_OPERATION_ID, getSnoozeMaxMs } from '@aflow/schemas';

export interface StepInFlightStatus {
  alive: boolean;
  deadlineAtMs: number | null;
}

export interface StepCompletionPathDeps {
  redis: Redis;
  getStepInFlight: (redis: Redis, stepExecutionId: string) => Promise<StepInFlightStatus>;
  hasAvailableExecutor: (redis: Redis, stepType: StepType) => Promise<boolean>;
  getShardTimer: (redis: Redis, identity: TimerIdentity) => Promise<TimerItem | null>;
}

/**
 * How a SCHEDULED step waits on its missing executor (Plan 315 D21). `armed`:
 * its `executor_wait` timer has looks left to take. `timer_lost`: the step is
 * marked waiting but no timer is left to look for it.
 */
export type ExecutorWaitPath = 'armed' | 'timer_lost';

export interface StepCompletionPath {
  /**
   * True when the current step still has a live completion authority: a STARTED
   * step whose executor is in-flight within its deadline+backstop, a SCHEDULED
   * step an executor has claimed, or a SCHEDULED step still inside its pickup
   * grace (plus the full snooze window for
   * the snooze op — its timer IS the completion path), or a SCHEDULED step
   * waiting on its executor. Elapsed wall-clock age alone is never evidence of
   * failure.
   */
  hasCompletionPath: boolean;
  isStarted: boolean;
  /** STARTED → executor in-flight; SCHEDULED → in-flight, or an executor for the type is available. */
  executorOwnsStep: boolean;
  /** The in-flight key's own deadline (STARTED only); null otherwise. */
  stepDeadlineAtMs: number | null;
  /**
   * Set when the step waits on its executor. The wait is a completion path of
   * its own, whatever the step's age: the timer's look budget is its only
   * ceiling, and a wait that lost its timer is re-armed, never failed. Null
   * for every other step, and for a wait whose looks are spent.
   */
  executorWait: ExecutorWaitPath | null;
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
 * timer-wait, not a stall. A step parked on its missing executor is not a
 * stalled pickup at all: its `executor_wait` timer is its completion path for
 * as long as the timer lives (`executorWait`), because a machine asleep or an
 * orchestrator restarting takes no looks and no grace measured in time can
 * know how long either lasts.
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

  const executorWait =
    isStarted || inflight.alive ? null : await classifyExecutorWait(deps, stepState);

  let hasCompletionPath: boolean;
  if (executorWait !== null) {
    hasCompletionPath = true;
  } else if (!isStarted && inflight.alive) {
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

  return { hasCompletionPath, isStarted, executorOwnsStep, stepDeadlineAtMs, executorWait };
}

/**
 * The wait is recognised by its live timer as well as by the step's marker: a
 * look in progress holds the timer leased, and a timer from a wait the marker
 * no longer names will not dispatch, so it counts as lost.
 */
async function classifyExecutorWait(
  deps: StepCompletionPathDeps,
  stepState: StepHotState,
): Promise<ExecutorWaitPath | null> {
  const timer = await deps.getShardTimer(deps.redis, {
    sessionId: stepState.sessionId as SessionId,
    stepExecutionId: stepState.stepExecutionId as StepExecutionId,
    reason: 'executor_wait',
    attempt: stepState.attempt,
  });
  const marker = stepState.executorWait?.sinceMs;
  const wait = timer?.executorWait;
  if (wait !== undefined && (marker === undefined || wait.sinceMs === marker)) {
    return executorWaitHasLooksLeft(wait) ? 'armed' : null;
  }
  return marker !== undefined ? 'timer_lost' : null;
}
