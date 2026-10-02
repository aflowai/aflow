/**
 * The signals `scripts/watch-and-drain.mjs` sends the service it supervises.
 *
 * A restart is the one stop that may wait: the watcher sends `DRAIN_SIGNAL`
 * and starts the service again once it has exited, never killing it. SIGTERM
 * and SIGINT mean "stop now" to the host executor, because every other
 * supervisor that sends them — the dev runner, `tsx watch`, launchd — kills
 * after a short grace, and work left running past a kill holds its credential
 * and its checkout with nothing to end it.
 *
 * The drain signal is the one the executor handles, read from where
 * `@aflow/lib` defines it.
 */
import drainSignal from '../packages/lib/src/drainSignal.json' with { type: 'json' };

export const DRAIN_SIGNAL = drainSignal.signal;

/**
 * @param {{ kind: 'restart' } | { kind: 'stop', signal: 'SIGTERM' | 'SIGINT', fromTerminal: boolean }} event
 * @returns {NodeJS.Signals | null} The signal to send the service, or null to send none.
 */
export function signalToSend(event) {
  if (event.kind === 'restart') return DRAIN_SIGNAL;
  // A Ctrl-C at a terminal reaches the service directly as well; passing it on
  // would deliver it twice.
  if (event.signal === 'SIGINT' && event.fromTerminal) return null;
  return event.signal;
}
