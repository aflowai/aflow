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
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

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

/**
 * Wrong PIN guesses per profile, kept in this process.
 *
 * The first four wrong guesses cost nothing. Each one after them makes the
 * profile wait before the next guess, 30 seconds at first and doubling to 15
 * minutes. A right PIN, a new PIN and a reset clear the count. A restart
 * clears it too, which is acceptable because restarting the API needs the
 * operator's machine, where the PIN guards nothing (D3).
 */
export class LocalProfilePinAttempts {
  private readonly failures = new Map<string, { count: number; waitUntil: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds until the profile may be tried again, or 0 when it may be tried now. */
  retryAfterSec(userId: string): number {
    const entry = this.failures.get(userId);
    if (entry === undefined) return 0;
    const wait = entry.waitUntil - this.now();
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  fail(userId: string): void {
    const count = (this.failures.get(userId)?.count ?? 0) + 1;
    const over = count - LOCAL_PROFILE_PIN_FREE_ATTEMPTS;
    const wait = over <= 0 ? 0 : Math.min(FIRST_WAIT_MS * 2 ** (over - 1), LONGEST_WAIT_MS);
    this.failures.set(userId, { count, waitUntil: this.now() + wait });
  }

  clear(userId: string): void {
    this.failures.delete(userId);
  }
}
