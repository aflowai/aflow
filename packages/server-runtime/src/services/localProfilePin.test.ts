/**
 * Plan 335 P4: a PIN is stored as a salted hash, and wrong guesses make the
 * profile wait. A PIN mark gives one browser a count of its own.
 */
import { describe, expect, it } from 'vitest';
import {
  LOCAL_PROFILE_PIN_FREE_ATTEMPTS,
  LocalProfilePinAttempts,
  hashLocalProfilePin,
  issueLocalProfilePinMark,
  readLocalProfilePinMark,
  verifyLocalProfilePin,
} from './localProfilePin.js';

describe('the PIN hash', () => {
  it('holds no digit of the PIN in the clear, and is salted', async () => {
    const first = await hashLocalProfilePin('2468');
    const second = await hashLocalProfilePin('2468');
    expect(first).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
    expect(await verifyLocalProfilePin('2468', first)).toBe(true);
    expect(await verifyLocalProfilePin('2468', second)).toBe(true);
  });

  it('matches no other PIN', async () => {
    const stored = await hashLocalProfilePin('123456');
    for (const guess of ['12345', '1234567', '654321', '', '123456 ']) {
      expect(await verifyLocalProfilePin(guess, stored)).toBe(false);
    }
  });

  it('matches nothing against a stored value it did not write', async () => {
    const stored = await hashLocalProfilePin('2468');
    for (const damaged of [
      '',
      '2468',
      stored.replace('scrypt', 'bcrypt'),
      stored.split('$').slice(0, 5).join('$'),
      `${stored}$extra`,
      stored.replace('$16384$', '$0$'),
    ]) {
      expect(await verifyLocalProfilePin('2468', damaged)).toBe(false);
    }
  });
});

describe('the wrong-guess count', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('lets the first wrong guesses through, then makes the profile wait', () => {
    const { now } = clock();
    const attempts = new LocalProfilePinAttempts(now);
    for (let i = 0; i < LOCAL_PROFILE_PIN_FREE_ATTEMPTS; i += 1) {
      attempts.fail('a', null);
      expect(attempts.retryAfterSec('a', null)).toBe(0);
    }
    attempts.fail('a', null);
    expect(attempts.retryAfterSec('a', null)).toBe(30);
    expect(attempts.retryAfterSec('b', null)).toBe(0);
  });

  it('doubles the wait with each further wrong guess, up to fifteen minutes', () => {
    const { now, advance } = clock();
    const attempts = new LocalProfilePinAttempts(now);
    for (let i = 0; i < LOCAL_PROFILE_PIN_FREE_ATTEMPTS + 1; i += 1) attempts.fail('a', null);
    advance(30_000);
    expect(attempts.retryAfterSec('a', null)).toBe(0);
    attempts.fail('a', null);
    expect(attempts.retryAfterSec('a', null)).toBe(60);
    for (let i = 0; i < 20; i += 1) attempts.fail('a', null);
    expect(attempts.retryAfterSec('a', null)).toBe(15 * 60);
  });

  it('forgets the count once cleared', () => {
    const attempts = new LocalProfilePinAttempts(clock().now);
    for (let i = 0; i < 10; i += 1) attempts.fail('a', null);
    attempts.clear('a', null);
    expect(attempts.retryAfterSec('a', null)).toBe(0);
    attempts.fail('a', null);
    expect(attempts.retryAfterSec('a', null)).toBe(0);
  });

  it('keeps a marked browser apart from browsers with no mark', () => {
    const attempts = new LocalProfilePinAttempts(clock().now);
    for (let i = 0; i < 10; i += 1) attempts.fail('a', null);
    expect(attempts.retryAfterSec('a', null)).toBeGreaterThan(0);
    expect(attempts.retryAfterSec('a', 'owner-browser')).toBe(0);

    for (let i = 0; i < 10; i += 1) attempts.fail('a', 'owner-browser');
    attempts.clear('a', 'owner-browser');
    expect(attempts.retryAfterSec('a', 'owner-browser')).toBe(0);
    expect(attempts.retryAfterSec('a', null)).toBeGreaterThan(0);
  });

  it('forgets every count of a profile for a new PIN or a reset', () => {
    const attempts = new LocalProfilePinAttempts(clock().now);
    for (let i = 0; i < 10; i += 1) {
      attempts.fail('a', null);
      attempts.fail('a', 'owner-browser');
      attempts.fail('b', null);
    }
    attempts.forget('a');
    expect(attempts.retryAfterSec('a', null)).toBe(0);
    expect(attempts.retryAfterSec('a', 'owner-browser')).toBe(0);
    expect(attempts.retryAfterSec('b', null)).toBeGreaterThan(0);
  });
});

describe('the PIN mark', () => {
  const SECRET = 's'.repeat(48);
  const USER = '00000000-0000-4000-8000-000000000b0b';
  const OTHER = '00000000-0000-4000-8000-0000000ed1c1';

  it('reads back as its own nonce, and each mark is new', () => {
    const first = issueLocalProfilePinMark(USER, SECRET);
    const second = issueLocalProfilePinMark(USER, SECRET);
    expect(first).not.toBe(second);
    const nonce = readLocalProfilePinMark(first, USER, SECRET);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(readLocalProfilePinMark(second, USER, SECRET)).not.toBe(nonce);
  });

  it('reads as nothing for another profile, another secret or a made-up value', () => {
    const mark = issueLocalProfilePinMark(USER, SECRET);
    const [version, user, , mac] = mark.split('.');
    for (const value of [
      '',
      'made-up',
      `${version}.${user}.forged.${mac}`,
      `${mark}.extra`,
      mark.replace('m1.', 'm2.'),
    ]) {
      expect(readLocalProfilePinMark(value, USER, SECRET)).toBeNull();
    }
    expect(readLocalProfilePinMark(mark, OTHER, SECRET)).toBeNull();
    expect(readLocalProfilePinMark(mark, USER, 't'.repeat(48))).toBeNull();
    expect(readLocalProfilePinMark(mark, USER, '')).toBeNull();
  });
});
