/**
 * A machine waking from sleep, as the processes on it can tell (Plan 315 D21).
 *
 * Every heartbeat lapses while its machine sleeps, the executor's and each
 * in-flight step's alike, and on waking nothing has refreshed them yet. The
 * executor refreshes them at its first tick awake; the orchestrator holds
 * every reader that would judge them until it has had time to, so a woken
 * executor is not taken for a dead one and its running steps are neither failed
 * nor dispatched again.
 */

/**
 * The shortest sleep that counts as one: below the slack of any heartbeat
 * (fifty seconds for an executor beating every ten under a sixty-second
 * lifetime), above any step a clock daemon makes to the wall clock.
 */
export const WAKE_MIN_SLEEP_MS = 30_000;

/**
 * How long the orchestrator's readers wait after it wakes: two of the executor
 * runtime's ten-second heartbeat ticks, the first of which refreshes the
 * executor's heartbeat and those of the steps it is running.
 */
export const EXECUTOR_WAKE_HOLD_MS = 20_000;

export interface WakeClock {
  wallMs(): number;
  /** A clock that does not advance while the machine sleeps. */
  monotonicMs(): number;
}

const systemClock: WakeClock = {
  wallMs: () => Date.now(),
  monotonicMs: () => performance.now(),
};

export interface WakeDetector {
  /** How long the machine slept since the last observation, or 0 when it did not. */
  observe(): number;
}

/**
 * Reads a sleep as the wall clock moving ahead of the monotonic one, which
 * stands still while the machine sleeps on macOS and Linux. The amount is also
 * how far every timer of the process moved later in wall time, its own step
 * timeouts among them.
 */
export function createWakeDetector(clock: WakeClock = systemClock): WakeDetector {
  const unseenMs = (): number => clock.wallMs() - clock.monotonicMs();
  let last = unseenMs();
  return {
    observe(): number {
      const now = unseenMs();
      const sleptMs = now - last;
      last = now;
      return sleptMs >= WAKE_MIN_SLEEP_MS ? sleptMs : 0;
    },
  };
}
