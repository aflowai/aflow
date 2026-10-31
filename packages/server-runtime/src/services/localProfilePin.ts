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
/**
 * How long a count outlives its wait with no further wrong guess. Dropping it
 * frees at most the free guesses and the one that started the wait. Waiting
 * this long for them costs as much per guess as the longest wait does.
 */
const COUNT_LIFETIME_MS = (LOCAL_PROFILE_PIN_FREE_ATTEMPTS + 1) * LONGEST_WAIT_MS;

/** PIN marks a profile keeps live at once. One more drops the least recently used. */
export const LOCAL_PROFILE_PIN_LIVE_MARKS = 8;

const MARK_VERSION = 'm2';
const MARK_NONCE_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const COUNTER = /^(0|[1-9][0-9]{0,15})$/;

function markMac(payload: string, instanceSecret: string): Buffer {
  const key = createHmac('sha256', instanceSecret).update('aflow-local-profile-pin-mark').digest();
  return createHmac('sha256', key).update(payload).digest();
}

/**
 * A browser's PIN mark for one profile: `m2.<user id>.<generation>.<nonce>.<MAC>`.
 *
 * The API issues one only with a right PIN, so a browser that never knew the
 * PIN holds none and cannot make one up. The mark grants nothing. It only
 * names the count its browser's wrong guesses go to. `generation` is the
 * profile's session generation, which every PIN change and reset bumps.
 */
export function issueLocalProfilePinMark(
  userId: string,
  generation: number,
  instanceSecret: string,
): { mark: string; nonce: string } {
  if (instanceSecret === '') throw new Error('A PIN mark needs the instance secret.');
  const nonce = randomBytes(MARK_NONCE_BYTES).toString('base64url');
  const payload = `${MARK_VERSION}.${userId}.${String(generation)}.${nonce}`;
  return { mark: `${payload}.${markMac(payload, instanceSecret).toString('base64url')}`, nonce };
}

/**
 * The nonce of a mark this instance issued for `userId` at `generation`, or
 * null for any other value. A mark issued before a PIN change or a reset
 * therefore reads as none (Plan 335 §14).
 */
export function readLocalProfilePinMark(
  value: string,
  userId: string,
  generation: number,
  instanceSecret: string,
): string | null {
  if (instanceSecret === '') return null;
  const [version, markedUser, markedGeneration, nonce, mac, ...rest] = value.split('.');
  if (rest.length > 0 || version !== MARK_VERSION || markedUser !== userId) return null;
  if (markedGeneration === undefined || !COUNTER.test(markedGeneration)) return null;
  if (Number(markedGeneration) !== generation) return null;
  if (nonce === undefined || mac === undefined || !BASE64URL.test(nonce)) return null;
  const presented = Buffer.from(mac, 'base64url');
  const expected = markMac(
    `${MARK_VERSION}.${userId}.${markedGeneration}.${nonce}`,
    instanceSecret,
  );
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return nonce;
}

interface PinFailure {
  count: number;
  waitUntil: number;
}

/** One guess `fail` counted: the count it went to, as it was before and after. */
export interface PinGuess {
  readonly userId: string;
  readonly mark: string | null;
  readonly before: PinFailure | undefined;
  readonly after: PinFailure;
}

/**
 * Wrong PIN guesses per profile and browser, kept in this process.
 *
 * Each profile has one count for browsers with no mark, and one for each live
 * mark a right PIN issued. A browser that never knew the PIN therefore makes
 * only the unmarked count wait, and a browser that has opened the profile
 * keeps its own (Plan 335 §14). Someone with the marked browser itself still
 * shares that browser's count, because nothing tells them from its owner.
 *
 * A profile keeps at most `LOCAL_PROFILE_PIN_LIVE_MARKS` marks live. A signed
 * mark that is not live counts with the browsers that have none, so knowing
 * the PIN buys at most that many counts of free guesses.
 *
 * The first four wrong guesses on a count cost nothing. Each one after them
 * makes that count wait before the next guess, 30 seconds at first and
 * doubling to 15 minutes. A right PIN sent with a live mark clears that mark's
 * count. A right PIN sent with none takes back only its own guess, because
 * the unmarked count holds the guesses of every browser with no mark. A count
 * goes once it has outlived its wait by `COUNT_LIFETIME_MS`. A new PIN and a
 * reset clear every count and every live mark of the profile. A restart
 * clears them too, which is acceptable because restarting the API needs the
 * operator's machine, where the PIN guards nothing (D3).
 */
export class LocalProfilePinAttempts {
  private readonly failures = new Map<string, Map<string, PinFailure>>();
  /** Live mark nonces per profile, least recently used first. */
  private readonly marks = new Map<string, string[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Seconds until the count may be tried again, or 0 when it may be tried now.
   * `mark` is the nonce of the browser's live mark, or null for a browser with none.
   */
  retryAfterSec(userId: string, mark: string | null): number {
    const entry = this.failures.get(userId)?.get(mark ?? '');
    if (entry === undefined) return 0;
    const wait = entry.waitUntil - this.now();
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  /**
   * Counts one guess against the count. The answer is what `withdraw` needs
   * to take that guess back once it proves right.
   */
  fail(userId: string, mark: string | null): PinGuess {
    this.prune();
    const counts = this.failures.get(userId) ?? new Map<string, PinFailure>();
    const before = counts.get(mark ?? '');
    const count = (before?.count ?? 0) + 1;
    const over = count - LOCAL_PROFILE_PIN_FREE_ATTEMPTS;
    const wait = over <= 0 ? 0 : Math.min(FIRST_WAIT_MS * 2 ** (over - 1), LONGEST_WAIT_MS);
    const after: PinFailure = { count, waitUntil: this.now() + wait };
    counts.set(mark ?? '', after);
    this.failures.set(userId, counts);
    return { userId, mark, before, after };
  }

  /** Clears a live mark's count, for a right PIN sent with that mark. */
  clear(userId: string, mark: string): void {
    this.dropCount(userId, mark);
  }

  /**
   * Takes back one guess `fail` counted, because it proved right. Every other
   * guess on the count stays, so a right PIN on the shared unmarked count
   * leaves the waits other browsers earned. With no guess counted since, the
   * count returns to what it was. Otherwise it drops by one and keeps its wait.
   */
  withdraw(guess: PinGuess): void {
    const key = guess.mark ?? '';
    const counts = this.failures.get(guess.userId);
    const current = counts?.get(key);
    if (counts === undefined || current === undefined) return;
    if (current === guess.after) {
      if (guess.before === undefined) this.dropCount(guess.userId, key);
      else counts.set(key, guess.before);
      return;
    }
    if (current.count <= 1) this.dropCount(guess.userId, key);
    else counts.set(key, { count: current.count - 1, waitUntil: current.waitUntil });
  }

  /** Whether `nonce` names one of the profile's live marks. */
  isLive(userId: string, nonce: string): boolean {
    return this.marks.get(userId)?.includes(nonce) ?? false;
  }

  /**
   * Makes `nonce` the profile's most recently used live mark. Past the bound,
   * the least recently used mark stops being live and its count goes with it.
   */
  keepMark(userId: string, nonce: string): void {
    const live = (this.marks.get(userId) ?? []).filter((kept) => kept !== nonce);
    live.push(nonce);
    while (live.length > LOCAL_PROFILE_PIN_LIVE_MARKS) {
      const dropped = live.shift();
      if (dropped !== undefined) this.dropCount(userId, dropped);
    }
    this.marks.set(userId, live);
  }

  /** Clears every count and live mark of the profile, for a new PIN, a reset or a removal. */
  forget(userId: string): void {
    this.failures.delete(userId);
    this.marks.delete(userId);
  }

  private dropCount(userId: string, key: string): void {
    const counts = this.failures.get(userId);
    counts?.delete(key);
    if (counts?.size === 0) this.failures.delete(userId);
  }

  private prune(): void {
    const cutoff = this.now() - COUNT_LIFETIME_MS;
    for (const [userId, counts] of this.failures) {
      for (const [key, entry] of counts) {
        if (entry.waitUntil <= cutoff) counts.delete(key);
      }
      if (counts.size === 0) this.failures.delete(userId);
    }
  }
}
