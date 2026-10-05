import { createWakeDetector, EXECUTOR_WAKE_HOLD_MS, type WakeDetector } from '@aflow/redis';

/**
 * What every reader that judges an executor by its heartbeats waits on after
 * this process wakes (Plan 315 D21): the result and control consumers, the
 * timers the stall watchdog rides, the barrier watchdog and the workflow-run
 * sweeper. An executor on the same machine slept too, and its heartbeat and its
 * steps' in-flight records lapsed with it; read before its first tick awake, it
 * is taken for dead, its steps failed and dispatched again while it still runs
 * them. One hold for the process, so each reader observing it sees one wake.
 */
export interface WakeHold {
  /** How much longer to hold, observing the clock first; 0 when nothing is held. */
  remainingMs(): number;
}

export interface WakeHoldOptions {
  detector?: WakeDetector;
  now?: () => number;
  onWake?: (sleptMs: number) => void;
}

export function createWakeHold(options: WakeHoldOptions = {}): WakeHold {
  const detector = options.detector ?? createWakeDetector();
  const now = options.now ?? Date.now;
  let heldUntil = 0;
  return {
    remainingMs(): number {
      const sleptMs = detector.observe();
      if (sleptMs > 0) {
        heldUntil = now() + EXECUTOR_WAKE_HOLD_MS;
        options.onWake?.(sleptMs);
      }
      return Math.max(0, heldUntil - now());
    },
  };
}
