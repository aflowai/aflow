/**
 * When a supervisor starts a service again after it exits. The appliance's
 * launcher (`prod-launcher.mjs`) and the dev stack (`dev.mjs`,
 * `watch-service.mjs`) decide by this one rule, so a crash the appliance
 * recovers from is one the dev stack recovers from too.
 *
 * Only a non-zero exit is restarted. A clean exit is a service that chose to
 * stop, and a kill by signal is somebody stopping it; starting either again
 * would overrule them.
 */

export const MIN_RESTART_DELAY_MS = 2_000;
export const MAX_RESTART_DELAY_MS = 30_000;
/** A service up this long before it exits starts again at the shortest delay. */
export const STABLE_UPTIME_MS = 60_000;

/**
 * @param {{ code: number | null, uptimeMs: number, backoffMs: number | undefined }} exit
 *   `backoffMs` is the delay this service's last restart left for the next one.
 * @returns {{ restart: false } | { restart: true, delayMs: number, nextBackoffMs: number }}
 */
export function restartAfterExit({ code, uptimeMs, backoffMs }) {
  if (code === null || code === 0) return { restart: false };
  const delayMs =
    backoffMs === undefined || uptimeMs >= STABLE_UPTIME_MS ? MIN_RESTART_DELAY_MS : backoffMs;
  return {
    restart: true,
    delayMs,
    nextBackoffMs: Math.min(delayMs * 2, MAX_RESTART_DELAY_MS),
  };
}
