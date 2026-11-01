/**
 * Waiting for the machine to quieten before a check runs again.
 *
 * A check whose first run lost only tests to their time lost them to the
 * machine's load, and the same load fails a second run started at once in the
 * same way. So the second run waits until the one-minute load average is below
 * the core count — the machine has a core to spare — or until
 * `HOST_CHECK_QUIET_WAIT_MAX_MS` has passed, and then runs either way. The
 * wait is recorded, so a reader knows the second run was not the first one
 * again.
 */
import { availableParallelism, loadavg } from 'node:os';

import { HOST_CHECK_QUIET_WAIT_MAX_MS, type HostCommitCheckQuietWaitSchema } from '@aflow/schemas';
import type { z } from 'zod';

export type QuietWait = z.infer<typeof HostCommitCheckQuietWaitSchema>;

/** How often the load is read while waiting. */
export const QUIET_POLL_MS = 15_000;

export interface MachineLoad {
  /** The one-minute load average. */
  loadAverage: () => number;
  cores: () => number;
}

export const thisMachine: MachineLoad = {
  loadAverage: () => loadavg()[0] ?? 0,
  cores: () => availableParallelism(),
};

export interface QuietWaitOptions {
  readonly signal: AbortSignal;
  readonly machine?: MachineLoad;
  readonly maxMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called once, where the machine is loaded when the wait begins. */
  readonly onWaiting?: (loadAverage: number, cores: number) => void;
  /** Called on every read of the load while waiting, so the step is seen to be alive. */
  readonly onPoll?: () => void;
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Wait until the one-minute load average is below the core count, at most
 * `maxMs`, and say how long that took and how it ended. An abort ends the
 * wait at once, as not quiet.
 */
export async function waitForQuietMachine(options: QuietWaitOptions): Promise<QuietWait> {
  const machine = options.machine ?? thisMachine;
  const maxMs = options.maxMs ?? HOST_CHECK_QUIET_WAIT_MAX_MS;
  const pollMs = options.pollMs ?? QUIET_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepUnlessAborted;
  const startedAt = now();
  let announced = false;
  for (;;) {
    const loadAverage = machine.loadAverage();
    const cores = Math.max(1, machine.cores());
    const waitedMs = Math.max(0, Math.round(now() - startedAt));
    const record = { waitedMs, loadAverage: Math.max(0, loadAverage), cores };
    if (loadAverage < cores) return { ...record, quiet: true };
    if (waitedMs >= maxMs || options.signal.aborted) return { ...record, quiet: false };
    if (!announced) {
      announced = true;
      options.onWaiting?.(loadAverage, cores);
    }
    options.onPoll?.();
    await sleep(Math.min(pollMs, maxMs - waitedMs), options.signal);
  }
}

/** One sentence for the check's summary and its live output. */
export function describeQuietWait(wait: QuietWait): string {
  const load = `${wait.loadAverage.toFixed(1)} on ${String(wait.cores)} core${wait.cores === 1 ? '' : 's'}`;
  if (wait.waitedMs === 0 && wait.quiet) {
    return `The machine was quiet when the checks were asked to wait for it (load average ${load}), so they ran at once.`;
  }
  const waited = formatWait(wait.waitedMs);
  return wait.quiet
    ? `The checks waited ${waited} for the machine to quieten, until its load average was ${load}.`
    : `The checks waited ${waited} for the machine to quieten and then ran on a loaded machine, its load average ${load}.`;
}

function formatWait(ms: number): string {
  if (ms < 60_000) return `${String(Math.round(ms / 1000))} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}
