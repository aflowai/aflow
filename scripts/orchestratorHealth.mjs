/**
 * What `yarn start` says about the orchestrator once the stack is up.
 *
 * Every other service shows its absence on its own — a port stops answering, a
 * page stops loading — but the API keeps accepting messages, results and
 * cancellations while no orchestrator consumes them, so a stopped orchestrator
 * otherwise reads as a stack that is merely quiet. The terminal that started
 * the stack says when it stops consuming and when it is back, from the
 * orchestrators' leases as the API reads them (`GET /v1/health/orchestrator`).
 */

export const ORCHESTRATOR_HEALTH_PATH = '/v1/health/orchestrator';

/** Half the orchestrator's 30-second lease: a lapse takes a whole lease to appear. */
export const ORCHESTRATOR_POLL_MS = 15_000;

/**
 * Readings in a row an absence holds before it is reported. The API answers a
 * moment before a starting orchestrator registers, and a restarted one is
 * absent for a few seconds; neither is worth a warning.
 */
export const ABSENT_READINGS_TO_REPORT = 2;

/** Bounded so a hung API delays the next reading rather than every one after it. */
const READ_TIMEOUT_MS = 3_000;

export const INITIAL_ORCHESTRATOR_WATCH = Object.freeze({ seen: 'unknown', absentReadings: 0 });

/**
 * One reading of `/v1/health/orchestrator`, or undefined when the API did not
 * give one — which says nothing about the orchestrator, and is not reported as
 * its absence.
 *
 * @returns {Promise<{ alive: boolean, notice: string | null, lastHeartbeat: string | null } | undefined>}
 */
export async function readOrchestratorHealth(api, fetchFn = fetch) {
  try {
    const response = await fetchFn(`${api}${ORCHESTRATOR_HEALTH_PATH}`, {
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = await response.json();
    if (typeof body?.alive !== 'boolean') return undefined;
    return {
      alive: body.alive,
      notice: typeof body.notice === 'string' ? body.notice : null,
      lastHeartbeat: typeof body.lastHeartbeat === 'string' ? body.lastHeartbeat : null,
    };
  } catch {
    return undefined;
  }
}

function lastBeatClause(lastHeartbeat) {
  if (lastHeartbeat === null) return 'No orchestrator heartbeat is on record.';
  return `The last heartbeat was at ${new Date(lastHeartbeat).toLocaleTimeString()}.`;
}

/**
 * The watch after `reading`, and the line it calls for, if any: the first
 * sighting, an absence once it has held, and the return after one.
 *
 * @returns {{ watch: { seen: string, absentReadings: number }, line?: { level: 'info' | 'warn', text: string } }}
 */
export function nextOrchestratorReport(watch, reading) {
  if (reading === undefined) return { watch };

  if (reading.alive) {
    const next = { seen: 'alive', absentReadings: 0 };
    if (watch.seen === 'alive') return { watch: next };
    const text =
      watch.seen === 'absent'
        ? 'an orchestrator is consuming again'
        : 'an orchestrator is consuming the control, result and timer streams';
    return { watch: next, line: { level: 'info', text } };
  }

  const absentReadings = watch.absentReadings + 1;
  if (watch.seen === 'absent' || absentReadings < ABSENT_READINGS_TO_REPORT) {
    return { watch: { seen: watch.seen, absentReadings } };
  }
  const notice = reading.notice ?? 'No orchestrator is running.';
  return {
    watch: { seen: 'absent', absentReadings },
    line: { level: 'warn', text: `${notice} ${lastBeatClause(reading.lastHeartbeat)}` },
  };
}
