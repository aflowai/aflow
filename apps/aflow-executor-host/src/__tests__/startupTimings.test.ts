/**
 * Contract (Plan 315 D21): a cold start reports how long the executor took
 * from the process starting to being ready, and what each part of it took.
 */
import { describe, expect, it } from 'vitest';

import { createStartupTimings } from '../startupTimings.js';

describe('timing a cold start', () => {
  it('times each part from the end of the one before, and readiness from the process start', () => {
    let now = 0;
    const timings = createStartupTimings(() => now);

    now = 420.4;
    timings.step('load');
    now = 3_420.4;
    timings.step('credential');
    now = 3_900;
    timings.step('cleanup');
    now = 4_150.6;
    timings.step('runtimes');

    expect(timings.ready()).toEqual({
      readyMs: 4_151,
      steps: { load: 420, credential: 3_000, cleanup: 480, runtimes: 251 },
    });
  });
});
