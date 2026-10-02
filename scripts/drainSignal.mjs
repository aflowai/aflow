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
 * @param {{ kind: 'restart' } | { kind: 'stop', signal: 'SIGTERM' | 'SIGINT' }} event
 * @returns {NodeJS.Signals} The signal to send the service.
 */
export function signalToSend(event) {
  if (event.kind === 'restart') return DRAIN_SIGNAL;
  // Passed on even when a terminal has delivered the same Ctrl-C to the
  // service: whether it did cannot be told from here — a `kill -INT` to a
  // foreground wrapper reaches it alone — and a second SIGINT only repeats a
  // stop the service has already begun.
  return event.signal;
}
