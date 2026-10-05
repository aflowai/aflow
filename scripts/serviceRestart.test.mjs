/**
 * The restart rule the appliance's launcher and the dev stack share: a crash
 * is started again, sooner after a long run than after a short one, and a
 * clean exit or a kill is left alone.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_RESTART_DELAY_MS,
  MIN_RESTART_DELAY_MS,
  STABLE_UPTIME_MS,
  restartAfterExit,
} from './serviceRestart.mjs';

const BRIEFLY_MS = 1_000;

/** The delays a service crashing `count` times in a row, each soon after starting, waits. */
function delaysOfCrashLoop(count) {
  const delays = [];
  let backoffMs;
  for (let crash = 0; crash < count; crash += 1) {
    const decision = restartAfterExit({ code: 1, uptimeMs: BRIEFLY_MS, backoffMs });
    if (!decision.restart) throw new Error('a crash was not restarted');
    delays.push(decision.delayMs);
    backoffMs = decision.nextBackoffMs;
  }
  return delays;
}

describe('restartAfterExit', () => {
  it('starts a crashed service again, backing off while it keeps crashing, up to a ceiling', () => {
    expect(delaysOfCrashLoop(7)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(Math.max(...delaysOfCrashLoop(20))).toBe(MAX_RESTART_DELAY_MS);
  });

  it('starts one that ran a while before it crashed at the shortest delay again', () => {
    expect(
      restartAfterExit({ code: 1, uptimeMs: STABLE_UPTIME_MS, backoffMs: MAX_RESTART_DELAY_MS }),
    ).toMatchObject({ restart: true, delayMs: MIN_RESTART_DELAY_MS });
  });

  it('leaves a clean exit, and a kill by signal, alone', () => {
    expect(restartAfterExit({ code: 0, uptimeMs: BRIEFLY_MS, backoffMs: undefined })).toEqual({
      restart: false,
    });
    expect(restartAfterExit({ code: null, uptimeMs: BRIEFLY_MS, backoffMs: undefined })).toEqual({
      restart: false,
    });
  });
});
