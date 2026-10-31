/**
 * Plan 335 P4: a PIN is stored as a salted hash, and wrong guesses make the
 * profile wait. A PIN mark gives one browser a count of its own.
 */
import { describe, expect, it } from 'vitest';
import {
  LOCAL_PROFILE_PIN_FREE_ATTEMPTS,
  LOCAL_PROFILE_PIN_LIVE_MARKS,
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
    attempts.keepMark('a', 'owner-browser');
    attempts.forget('a');
    expect(attempts.retryAfterSec('a', null)).toBe(0);
    expect(attempts.retryAfterSec('a', 'owner-browser')).toBe(0);
    expect(attempts.isLive('a', 'owner-browser')).toBe(false);
    expect(attempts.retryAfterSec('b', null)).toBeGreaterThan(0);
  });

  it('keeps a bounded number of live marks, dropping the least recently used', () => {
    const attempts = new LocalProfilePinAttempts(clock().now);
    for (let i = 0; i < LOCAL_PROFILE_PIN_LIVE_MARKS; i += 1) attempts.keepMark('a', `m${i}`);
    for (let i = 0; i < 10; i += 1) attempts.fail('a', 'm1');
    // m0 used again, so m1 is now the least recently used.
    attempts.keepMark('a', 'm0');
    attempts.keepMark('a', 'newest');
    expect(attempts.isLive('a', 'm0')).toBe(true);
    expect(attempts.isLive('a', 'newest')).toBe(true);
    expect(attempts.isLive('a', 'm1')).toBe(false);
    expect(attempts.retryAfterSec('a', 'm1')).toBe(0);
    expect(attempts.isLive('b', 'm0')).toBe(false);
  });

  it('drops a count once it has outlived its wait, and only then', () => {
    const { now, advance } = clock();
    const attempts = new LocalProfilePinAttempts(now);
    for (let i = 0; i < LOCAL_PROFILE_PIN_FREE_ATTEMPTS + 1; i += 1) attempts.fail('a', 'gone');
    for (let i = 0; i < LOCAL_PROFILE_PIN_FREE_ATTEMPTS; i += 1) attempts.fail('a', 'kept');
    // Past the wait but not past the count's lifetime, the count still stands.
    advance(30_000 + 60 * 60_000);
    attempts.fail('a', 'kept');
    expect(attempts.retryAfterSec('a', 'kept')).toBe(30);
    advance(15 * 60_000);
    attempts.fail('b', null);
    // 'gone' was pruned, so its next wrong guess is a free one again.
    attempts.fail('a', 'gone');
    expect(attempts.retryAfterSec('a', 'gone')).toBe(0);
    // 'kept' last waited until 30 seconds after its fifth guess, too recent to drop.
    attempts.fail('a', 'kept');
    expect(attempts.retryAfterSec('a', 'kept')).toBe(60);
  });
});

describe('the PIN mark', () => {
  const SECRET = 's'.repeat(48);
  const USER = '00000000-0000-4000-8000-000000000b0b';
  const OTHER = '00000000-0000-4000-8000-0000000ed1c1';

  it('reads back as its own nonce, and each mark is new', () => {
    const first = issueLocalProfilePinMark(USER, 3, SECRET);
    const second = issueLocalProfilePinMark(USER, 3, SECRET);
    expect(first.mark).not.toBe(second.mark);
    expect(first.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(readLocalProfilePinMark(first.mark, USER, 3, SECRET)).toBe(first.nonce);
    expect(readLocalProfilePinMark(second.mark, USER, 3, SECRET)).toBe(second.nonce);
    expect(second.nonce).not.toBe(first.nonce);
  });

  it('reads as nothing once the PIN has changed or been reset', () => {
    const { mark } = issueLocalProfilePinMark(USER, 3, SECRET);
    expect(readLocalProfilePinMark(mark, USER, 4, SECRET)).toBeNull();
    expect(readLocalProfilePinMark(mark, USER, 2, SECRET)).toBeNull();
    // Rewriting the generation breaks the signature.
    expect(readLocalProfilePinMark(mark.replace('.3.', '.4.'), USER, 4, SECRET)).toBeNull();
  });

  it('reads as nothing for another profile, another secret or a made-up value', () => {
    const { mark } = issueLocalProfilePinMark(USER, 0, SECRET);
    const [version, user, generation, , mac] = mark.split('.');
    for (const value of [
      '',
      'made-up',
      `${version}.${user}.${generation}.forged.${mac}`,
      `${version}.${user}.00.forged.${mac}`,
      `${mark}.extra`,
      mark.replace('m2.', 'm1.'),
    ]) {
      expect(readLocalProfilePinMark(value, USER, 0, SECRET)).toBeNull();
    }
    expect(readLocalProfilePinMark(mark, OTHER, 0, SECRET)).toBeNull();
    expect(readLocalProfilePinMark(mark, USER, 0, 't'.repeat(48))).toBeNull();
    expect(readLocalProfilePinMark(mark, USER, 0, '')).toBeNull();
  });
});
