/**
 * Reading a page once it has stopped changing.
 *
 * A page that a script re-renders — a single-page application following a
 * link, a form that validates as it goes — has no event that says it is done.
 * Waiting for one that never comes is what made an action take thirty seconds
 * and still return the page it left. So the page is read until two reads a
 * moment apart agree, for at most a short while, and the last read is returned
 * with whether that happened.
 */

/** How far apart two reads are taken when deciding whether the page is quiet. */
export const OUTLINE_QUIET_INTERVAL_MS = 250;
/** The longest a page is read for before the last read is returned unsettled. */
export const OUTLINE_SETTLE_CAP_MS = 3_000;

export interface SettleClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export const realClock: SettleClock = {
  now: Date.now,
  sleep: async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  },
};

export interface Settled<T> {
  readonly read: T;
  readonly settled: boolean;
}

/**
 * Reads until two consecutive reads have the same `key`, or the cap passes.
 * A read that fails ends the wait with that failure.
 */
export async function readWhenQuiet<T>(
  read: () => Promise<T>,
  key: (read: T) => string,
  clock: SettleClock,
  capMs: number = OUTLINE_SETTLE_CAP_MS,
): Promise<Settled<T>> {
  const deadline = clock.now() + capMs;
  let last = await read();
  while (clock.now() + OUTLINE_QUIET_INTERVAL_MS <= deadline) {
    await clock.sleep(OUTLINE_QUIET_INTERVAL_MS);
    const next = await read();
    if (key(next) === key(last)) return { read: next, settled: true };
    last = next;
  }
  return { read: last, settled: false };
}
