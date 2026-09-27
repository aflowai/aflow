import type { Redis } from 'ioredis';
import {
  LiveDeltaChannelSchema,
  StreamKeys,
  type ApiSessionEvent,
  type LiveDeltaChannel,
  type LiveDeltaFrame,
  type SessionId,
  type TenantId,
} from '@aflow/schemas';
import { readLiveDeltaFrom } from '@aflow/redis';

/**
 * The live plane's read side: the partial output of the step running right now.
 *
 * A value, not a log. There is no replay, no dedup and no gap detection here
 * because there is nothing to reconcile — a dropped frame costs the reader
 * nothing, and a reader that arrives late reads from offset 0 and gets the
 * whole partial in one round trip. The step's terminal event on the durable
 * plane supersedes everything this yields.
 *
 * This reader is driven by the durable tail loop rather than owning its own
 * subscription: on each wakeup the loop drains durable events (feeding them to
 * `observe`) and then calls `read`, so a step's terminal event is always
 * emitted before this reader is next asked for that step — and `observe`
 * records the terminal so `read` structurally never yields a frame for a step
 * whose terminal event already went out.
 *
 * A session watching a workflow run reads more than its own step. A step the
 * run dispatched to an operation belongs to no session at all, so the session
 * parked on the run is the only reader its buffer has; the run records that
 * step in the task row's `workerSessionId`, which arrives here on the same
 * `WorkflowTaskUpdate` events the surface is built from.
 */

export type { LiveDeltaFrame };

const LIVE_CHANNELS: readonly LiveDeltaChannel[] = LiveDeltaChannelSchema.options;

const STEP_TERMINAL_EVENT_TYPES = new Set(['StepSucceeded', 'StepFailed', 'StepPaused']);

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
]);

/**
 * How many recently-terminated step ids to remember. `currentStepExecutionId`
 * only ever names a recent step, so a small window is enough to reject a stale
 * hot-state read that still points at a step whose terminal event was drained.
 */
const TERMINATED_WINDOW = 64;

/**
 * How many of a run's task steps one session reads buffers for.
 *
 * Each tracked step costs one round trip per channel per wakeup, so a run that
 * fans out wide would otherwise make a wakeup's cost a function of its width.
 * A run's concurrently running tasks are few; the bound is what keeps that true
 * of the reader too.
 */
const MAX_TRACKED_TASK_STEPS = 16;

function offsetKey(stepExecutionId: string, channel: LiveDeltaChannel): string {
  return `${stepExecutionId}\u0000${channel}`;
}

export interface LiveDeltaReader {
  /** Feed every drained durable event so the reader tracks step lifecycle. */
  observe(event: ApiSessionEvent): void;
  /** Read whatever the in-flight step has buffered since the last call. */
  read(signal: AbortSignal): Promise<LiveDeltaFrame[]>;
}

export function createLiveDeltaReader(
  redis: Redis,
  tenantId: TenantId,
  sessionId: SessionId,
): LiveDeltaReader {
  const sessionStateKey = StreamKeys.sessionStateKey(tenantId, sessionId);
  const offsets = new Map<string, number>();
  const terminated = new Set<string>();
  // Keyed by task rather than by step, so a retry's new step replaces the
  // attempt before it instead of accumulating beside it.
  const taskSteps = new Map<string, string>();
  let currentStep: string | null = null;

  const forget = (stepExecutionId: string): void => {
    for (const channel of LIVE_CHANNELS) offsets.delete(offsetKey(stepExecutionId, channel));
  };

  return {
    observe(event: ApiSessionEvent): void {
      const taskUpdate = event.data.workflowTaskUpdate;
      if (taskUpdate) {
        const key = `${taskUpdate.runId}\u0000${taskUpdate.taskId}`;
        const step = taskUpdate.workerSessionId;
        const held = taskSteps.get(key);
        // An agent task's `workerSessionId` names a real session, whose own
        // steps stream under their own ids — none of them is this row. A human
        // task runs nothing. Only an operation task records its step here.
        const streams =
          taskUpdate.taskType !== 'agent' &&
          taskUpdate.taskType !== 'human' &&
          !TERMINAL_TASK_STATUSES.has(taskUpdate.status);
        if (held !== undefined && held !== step) forget(held);
        if (streams && step !== undefined) {
          if (taskSteps.has(key) || taskSteps.size < MAX_TRACKED_TASK_STEPS) {
            taskSteps.set(key, step);
          }
        } else {
          taskSteps.delete(key);
          if (held !== undefined) forget(held);
        }
        return;
      }
      const stepExecutionId = event.stepExecutionId;
      if (!stepExecutionId) return;
      if (!STEP_TERMINAL_EVENT_TYPES.has(event.eventType)) return;
      // A retryable failure emits StepFailed but the retry reuses this same
      // stepExecutionId, so the step is not done streaming — the STRLEN restart
      // in `readLiveDeltaFrom` handles the buffer's DEL-and-reappend. Marking it
      // terminated here would drop the retried attempt's stream entirely.
      if (event.eventType === 'StepFailed' && event.metadata?.['willRetry'] === true) return;
      terminated.add(stepExecutionId);
      if (terminated.size > TERMINATED_WINDOW) {
        const oldest = terminated.values().next().value;
        if (oldest !== undefined) terminated.delete(oldest);
      }
    },

    async read(signal: AbortSignal): Promise<LiveDeltaFrame[]> {
      // One field, one round trip, no Zod parse and no destructive
      // quarantine path — a read-only viewer must never be able to wipe a
      // live run's hot state.
      const inFlight = await redis.hget(sessionStateKey, 'currentStepExecutionId');
      const active = inFlight && !terminated.has(inFlight) ? inFlight : null;
      if (active !== currentStep) {
        if (currentStep !== null) forget(currentStep);
        currentStep = active;
      }

      const steps: string[] = [];
      if (currentStep !== null) steps.push(currentStep);
      for (const step of taskSteps.values()) {
        if (!steps.includes(step)) steps.push(step);
      }
      if (steps.length === 0) return [];

      const frames: LiveDeltaFrame[] = [];
      for (const step of steps) {
        for (const channel of LIVE_CHANNELS) {
          if (signal.aborted) break;
          const key = offsetKey(step, channel);
          const from = offsets.get(key) ?? 0;
          const read = await readLiveDeltaFrom(redis, tenantId, step, channel, from);
          offsets.set(key, read.offset);
          if (read.delta) {
            frames.push({
              stepExecutionId: step,
              channel,
              offset: read.startOffset,
              delta: read.delta,
            });
          }
        }
      }
      return frames;
    },
  };
}
