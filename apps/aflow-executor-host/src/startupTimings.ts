/**
 * How long a cold start of the host executor takes, from the process starting
 * to the executor claiming work, and what each part of it took. Plan 315 D21
 * leaves the cold restart to be measured before anything is built for it; this
 * is the executor's share of that measurement, logged once, when it is ready.
 */
export interface StartupTimings {
  /** Ends a part of the start, timed from the end of the one before. */
  step(name: string): void;
  ready(): { readyMs: number; steps: Record<string, number> };
}

/** `sinceProcessStartMs` defaults to `performance.now()`, which counts from the process's start. */
export function createStartupTimings(
  sinceProcessStartMs: () => number = () => performance.now(),
): StartupTimings {
  const steps: Record<string, number> = {};
  let last = 0;
  return {
    step(name: string): void {
      const now = sinceProcessStartMs();
      steps[name] = Math.round(now - last);
      last = now;
    },
    ready() {
      return { readyMs: Math.round(sinceProcessStartMs()), steps: { ...steps } };
    },
  };
}
