/**
 * Contract (Plan 315 D21): a sleep is read as the wall clock moving ahead of a
 * clock that stands still while the machine sleeps, reported once, by its
 * length, and only when it is long enough to have outlasted a heartbeat's slack.
 */
import { describe, expect, it } from 'vitest';

import { createWakeDetector, WAKE_MIN_SLEEP_MS } from '../streams/executorWake.js';

function machine() {
  let wall = 1_700_000_000_000;
  let monotonic = 0;
  return {
    clock: { wallMs: () => wall, monotonicMs: () => monotonic },
    run(ms: number) {
      wall += ms;
      monotonic += ms;
    },
    sleep(ms: number) {
      wall += ms;
    },
    stepWallClock(ms: number) {
      wall += ms;
    },
  };
}

describe('waking from sleep', () => {
  it('reports a sleep by its length, once', () => {
    const m = machine();
    const wake = createWakeDetector(m.clock);
    m.run(5_000);
    m.sleep(8 * 60 * 60 * 1000);
    m.run(1_000);

    expect(wake.observe()).toBe(8 * 60 * 60 * 1000);
    m.run(10_000);
    expect(wake.observe()).toBe(0);
  });

  it('reports nothing for time the process was awake, however long between looks', () => {
    const m = machine();
    const wake = createWakeDetector(m.clock);
    m.run(10 * 60 * 1000);
    expect(wake.observe()).toBe(0);
  });

  it('reports nothing for a sleep shorter than any heartbeat outlives, nor a clock set back', () => {
    const m = machine();
    const wake = createWakeDetector(m.clock);
    m.sleep(WAKE_MIN_SLEEP_MS - 1);
    expect(wake.observe()).toBe(0);
    m.stepWallClock(-60_000);
    expect(wake.observe()).toBe(0);
    m.sleep(WAKE_MIN_SLEEP_MS);
    expect(wake.observe()).toBe(WAKE_MIN_SLEEP_MS);
  });
});
