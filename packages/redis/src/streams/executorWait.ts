import { EXECUTOR_HEARTBEAT_TTL_SECONDS } from './executorHeartbeat.js';

/**
 * How long a step or operation task waits for a missing executor before it
 * fails. Long enough for what takes an executor away while work is queued for
 * it — a machine asleep and woken, a restart, the first heartbeat after either —
 * and short enough that an executor nobody is going to start is reported
 * missing within minutes rather than hidden.
 */
export const EXECUTOR_WAIT_WINDOW_MS = 10 * 60_000;

/** The first look again: an executor between two heartbeats has beaten by then. */
export const EXECUTOR_WAIT_FIRST_LOOK_MS = 10_000;

/**
 * The longest between two looks. A returning executor's heartbeat outlives
 * this, so looking less often would only hold back work it could already run.
 */
export const EXECUTOR_WAIT_LONGEST_LOOK_MS = EXECUTOR_HEARTBEAT_TTL_SECONDS * 1000;

/**
 * When to look for the executor next. The gap grows with the time already
 * waited, from the first look to the longest, so a lane that is down is asked
 * about a dozen times over the window however much work waits on it — and the
 * last look lands on the window's end, where the wait fails.
 */
export function executorWaitNextLookAtMs(sinceMs: number, nowMs: number): number {
  const waitedMs = Math.max(0, nowMs - sinceMs);
  const gapMs = Math.min(
    EXECUTOR_WAIT_LONGEST_LOOK_MS,
    Math.max(EXECUTOR_WAIT_FIRST_LOOK_MS, waitedMs),
  );
  return Math.min(nowMs + gapMs, sinceMs + EXECUTOR_WAIT_WINDOW_MS);
}

export function executorWaitExpired(sinceMs: number, nowMs: number): boolean {
  return nowMs - sinceMs >= EXECUTOR_WAIT_WINDOW_MS;
}
