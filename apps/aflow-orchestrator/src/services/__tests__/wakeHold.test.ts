/**
 * Contract (Plan 315 D21): once the orchestrator wakes, every reader of
 * executor liveness is held until the executors have had two heartbeat ticks
 * to say they are alive, and is free again after.
 */
import { describe, expect, it, vi } from 'vitest';
import { EXECUTOR_WAKE_HOLD_MS } from '@aflow/redis';

import { createWakeHold } from '../wakeHold.js';

function world() {
  let now = 1_700_000_000_000;
  let slept = 0;
  return {
    detector: {
      observe: () => {
        const s = slept;
        slept = 0;
        return s;
      },
    },
    now: () => now,
    pass(ms: number) {
      now += ms;
    },
    wake(ms: number) {
      slept = ms;
      now += ms;
    },
  };
}

describe('the hold after a wake', () => {
  it('holds nothing while the machine stays awake', () => {
    const w = world();
    const hold = createWakeHold({ detector: w.detector, now: w.now });
    expect(hold.remainingMs()).toBe(0);
    w.pass(60_000);
    expect(hold.remainingMs()).toBe(0);
  });

  it('holds for two executor heartbeats from the wake, says so once, and then lets go', () => {
    const w = world();
    const onWake = vi.fn();
    const hold = createWakeHold({ detector: w.detector, now: w.now, onWake });

    w.wake(8 * 60 * 60 * 1000);
    expect(hold.remainingMs()).toBe(EXECUTOR_WAKE_HOLD_MS);
    expect(onWake).toHaveBeenCalledWith(8 * 60 * 60 * 1000);

    w.pass(EXECUTOR_WAKE_HOLD_MS - 1);
    expect(hold.remainingMs()).toBe(1);
    w.pass(1);
    expect(hold.remainingMs()).toBe(0);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('starts the hold again for a second wake inside the first', () => {
    const w = world();
    const hold = createWakeHold({ detector: w.detector, now: w.now });
    w.wake(60_000);
    expect(hold.remainingMs()).toBe(EXECUTOR_WAKE_HOLD_MS);
    w.pass(5_000);
    w.wake(60_000);
    expect(hold.remainingMs()).toBe(EXECUTOR_WAKE_HOLD_MS);
  });
});
