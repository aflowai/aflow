import { EXECUTOR_HEARTBEAT_TTL_SECONDS } from './executorHeartbeat.js';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const EXECUTOR_HEARTBEAT_TTL_MS = EXECUTOR_HEARTBEAT_TTL_SECONDS * MS_PER_SECOND;

/** The first look again: an executor between two heartbeats has beaten by then. */
export const EXECUTOR_WAIT_FIRST_LOOK_MS = 10 * MS_PER_SECOND;

/**
 * The longest between two looks. A returning executor's heartbeat outlives
 * this, so looking less often would only hold back work it could already run.
 */
export const EXECUTOR_WAIT_LONGEST_LOOK_MS = EXECUTOR_HEARTBEAT_TTL_MS;

/**
 * The gap before the next look once `looks` have been taken. It grows with the
 * time those looks span on a machine that stays awake, from the first look to
 * the longest, so a lane that is down is asked about a dozen times however much
 * work waits on it.
 */
export function executorWaitGapMs(looks: number): number {
  let spannedMs = 0;
  for (let look = 0; look < looks; look += 1) spannedMs += gapAfter(spannedMs);
  return gapAfter(spannedMs);
}

function gapAfter(spannedMs: number): number {
  return Math.min(EXECUTOR_WAIT_LONGEST_LOOK_MS, Math.max(EXECUTOR_WAIT_FIRST_LOOK_MS, spannedMs));
}

function looksSpanning(spanMs: number): number {
  let looks = 0;
  for (let spannedMs = 0; spannedMs < spanMs; looks += 1) spannedMs += executorWaitGapMs(looks);
  return looks;
}

/**
 * How many looks a step or operation task takes for a missing executor before
 * it fails: as many as span ten minutes on a machine that stays awake. Long
 * enough for what takes an executor away while work is queued for it — a
 * restart, the first heartbeat after it — and short enough that an executor
 * nobody is going to start is reported missing within minutes rather than
 * hidden. Counted in looks, not in time, because a machine asleep takes none.
 */
export const EXECUTOR_WAIT_LOOKS = looksSpanning(10 * MS_PER_MINUTE);

/**
 * Whether a look came so long after it was due that the clock jumped under it
 * — the machine slept, or the orchestrator was stopped — rather than the look
 * merely running late. Every executor's heartbeat lapses across such a jump,
 * so the look says nothing about whether the executor is coming back.
 */
export function executorWaitClockJumped(dueAtMs: number, nowMs: number): boolean {
  return nowMs - dueAtMs > EXECUTOR_HEARTBEAT_TTL_MS;
}
