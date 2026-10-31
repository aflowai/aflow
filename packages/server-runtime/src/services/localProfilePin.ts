/**
 * A local profile's PIN (Plan 335 P4): how it is stored, how a guess is
 * compared, and how wrong guesses are slowed.
 *
 * The PIN is four to six digits, so a stored hash alone cannot stop someone
 * who reads the database from trying all of them. That person holds the
 * operator's OS account, and the PIN claims no boundary against them (D3).
 * The hash keeps the digits themselves out of the database and its backups,
 * because people reuse a PIN elsewhere.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const SCHEME = 'scrypt';
const PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

function derive(pin: string, salt: Buffer, params: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, KEY_LENGTH, params, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** `scrypt$N$r$p$<salt>$<key>`, salt and key in base64url. */
export async function hashLocalProfilePin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(pin, salt, PARAMS);
  return [
    SCHEME,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

const POSITIVE = /^[1-9][0-9]{0,6}$/;

/**
 * Whether `pin` is the PIN `stored` was made from. A stored value this module
 * did not write matches nothing, so a damaged hash locks the profile until
 * the owner resets it rather than opening it.
 */
export async function verifyLocalProfilePin(pin: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key, ...rest] = stored.split('$');
  if (scheme !== SCHEME || rest.length > 0) return false;
  if (n === undefined || r === undefined || p === undefined) return false;
  if (!POSITIVE.test(n) || !POSITIVE.test(r) || !POSITIVE.test(p)) return false;
  if (salt === undefined || key === undefined) return false;
  const expected = Buffer.from(key, 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  let presented: Buffer;
  try {
    presented = await derive(pin, Buffer.from(salt, 'base64url'), {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return timingSafeEqual(presented, expected);
}

/** Wrong guesses allowed before the profile waits. */
export const LOCAL_PROFILE_PIN_FREE_ATTEMPTS = 4;
const FIRST_WAIT_MS = 30_000;
const LONGEST_WAIT_MS = 15 * 60_000;

const MARK_VERSION = 'm1';
const MARK_NONCE_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function markMac(payload: string, instanceSecret: string): Buffer {
  const key = createHmac('sha256', instanceSecret).update('aflow-local-profile-pin-mark').digest();
  return createHmac('sha256', key).update(payload).digest();
}

/**
 * A browser's PIN mark for one profile: `m1.<user id>.<nonce>.<MAC>`.
 *
 * The API issues one only with a right PIN, so a browser that never knew the
 * PIN holds none and cannot make one up. The mark grants nothing. It only
 * names the count its browser's wrong guesses go to.
 */
export function issueLocalProfilePinMark(userId: string, instanceSecret: string): string {
  if (instanceSecret === '') throw new Error('A PIN mark needs the instance secret.');
  const payload = `${MARK_VERSION}.${userId}.${randomBytes(MARK_NONCE_BYTES).toString('base64url')}`;
  return `${payload}.${markMac(payload, instanceSecret).toString('base64url')}`;
}

/** The nonce of a mark this instance issued for `userId`, or null for any other value. */
export function readLocalProfilePinMark(
  value: string,
  userId: string,
  instanceSecret: string,
): string | null {
  if (instanceSecret === '') return null;
  const [version, markedUser, nonce, mac, ...rest] = value.split('.');
  if (rest.length > 0 || version !== MARK_VERSION || markedUser !== userId) return null;
  if (nonce === undefined || mac === undefined || !BASE64URL.test(nonce)) return null;
  const presented = Buffer.from(mac, 'base64url');
  const expected = markMac(`${MARK_VERSION}.${userId}.${nonce}`, instanceSecret);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return nonce;
}

interface PinFailure {
  count: number;
  waitUntil: number;
}

/**
 * Wrong PIN guesses per profile and browser, kept in this process.
 *
 * Each profile has one count for browsers with no mark, and one for each
 * mark a right PIN issued. A browser that never knew the PIN therefore makes
 * only the unmarked count wait, and a browser that has opened the profile
 * keeps its own (Plan 335 §14). Someone with the marked browser itself still
 * shares that browser's count, because nothing tells them from its owner.
 *
 * The first four wrong guesses on a count cost nothing. Each one after them
 * makes that count wait before the next guess, 30 seconds at first and
 * doubling to 15 minutes. A right PIN clears the count it was sent on. A new
 * PIN and a reset clear every count of the profile. A restart clears them
 * too, which is acceptable because restarting the API needs the operator's
 * machine, where the PIN guards nothing (D3).
 */
export class LocalProfilePinAttempts {
  private readonly failures = new Map<string, Map<string, PinFailure>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Seconds until the count may be tried again, or 0 when it may be tried now.
   * `mark` is the nonce of the browser's mark, or null for a browser with none.
   */
  retryAfterSec(userId: string, mark: string | null): number {
    const entry = this.failures.get(userId)?.get(mark ?? '');
    if (entry === undefined) return 0;
    const wait = entry.waitUntil - this.now();
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  fail(userId: string, mark: string | null): void {
    const counts = this.failures.get(userId) ?? new Map<string, PinFailure>();
    const count = (counts.get(mark ?? '')?.count ?? 0) + 1;
    const over = count - LOCAL_PROFILE_PIN_FREE_ATTEMPTS;
    const wait = over <= 0 ? 0 : Math.min(FIRST_WAIT_MS * 2 ** (over - 1), LONGEST_WAIT_MS);
    counts.set(mark ?? '', { count, waitUntil: this.now() + wait });
    this.failures.set(userId, counts);
  }

  /** Clears the one count a right PIN was sent on. */
  clear(userId: string, mark: string | null): void {
    const counts = this.failures.get(userId);
    counts?.delete(mark ?? '');
    if (counts?.size === 0) this.failures.delete(userId);
  }

  /** Clears every count of the profile, for a new PIN or a reset. */
  forget(userId: string): void {
    this.failures.delete(userId);
  }
}
