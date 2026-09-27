/**
 * Whether a review may be raised that nobody asked for.
 *
 * A coach review ran after every run, and a review could ask for another. One
 * three-message conversation reached 33,383 steps and 83,468 events at 4,345
 * events a minute for twenty-five minutes. Those are model calls, so the cost
 * was spend rather than noise, and nothing bounded it.
 *
 * Reviews raised deliberately — by an operator, or by a platform workflow —
 * are a different thing and are not governed by this.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { backgroundCoachReviewEnabled } from '../coachTrigger.js';

const KEY = 'COACH_AUTO_REVIEW_ENABLED';
const saved = process.env[KEY];

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe('backgroundCoachReviewEnabled', () => {
  it('is off when nothing says otherwise', () => {
    delete process.env[KEY];
    expect(backgroundCoachReviewEnabled()).toBe(false);
  });

  it('turns on only for an explicit 1', () => {
    process.env[KEY] = '1';
    expect(backgroundCoachReviewEnabled()).toBe(true);
  });

  it('stays off for the values that look like yes but are not', () => {
    // A breaker that opens on any truthy string opens by accident.
    for (const v of ['true', 'TRUE', 'yes', 'on', '2', '0', '', ' ']) {
      process.env[KEY] = v;
      expect(backgroundCoachReviewEnabled()).toBe(false);
    }
  });
});
