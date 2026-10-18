/**
 * The operator's sign-in, lent to a run and taken back (Plan 325 D4).
 *
 * A harness signed in with a subscription keeps its sign-in as a file, and the
 * file holds a refresh token the harness rotates. Home is denied to the run,
 * so the file is copied into the run's own configuration directory — by the
 * executor, outside the boundary, as the operator — and the harness reads it
 * there. A copy that refreshed holds the only live token afterwards, because
 * the refresh spent the one the operator's file still names; so it is written
 * back. It is written back only over the bytes it was copied from: an original
 * that changed meanwhile was refreshed by the operator's own harness, and that
 * one is newer than anything the run holds.
 *
 * Two runs copied from one token must not both refresh it — the second refresh
 * presents a spent token. A harness refreshes on start once its file has gone
 * unwritten for long enough, so runs seeded from a file that old take turns,
 * and runs seeded from a fresh one never wait on each other.
 */
import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { HarnessProfileError, type HarnessProfile } from './harnessProfiles.js';

export interface SeededFile {
  readonly original: string;
  readonly copy: string;
  readonly seeded: Buffer;
}

const tails = new Map<string, Promise<void>>();

/** Run `work` after every earlier holder of `key` has finished. */
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = before.then(() => mine);
  tails.set(key, tail);
  await before;
  try {
    return await work();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** True when a seeded file is old enough that the harness will refresh it on start. */
export async function dueForRefresh(
  profile: HarnessProfile,
  now: number = Date.now(),
): Promise<boolean> {
  const age = profile.configSeedRefreshAgeMs;
  if (age === undefined) return false;
  for (const path of profile.configSeed) {
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined && now - info.mtimeMs >= age) return true;
  }
  return false;
}

export async function seedConfig(
  profile: HarnessProfile,
  configDir: string,
): Promise<SeededFile[]> {
  const seeded: SeededFile[] = [];
  for (const original of profile.configSeed) {
    let bytes: Buffer;
    try {
      bytes = await readFile(original);
    } catch {
      throw new HarnessProfileError(
        `Harness '${profile.id}' signs in with ${original}, and there is no readable file ` +
          `there. Sign in to ${profile.label ?? profile.id} on this machine first.`,
        'unknown_profile',
      );
    }
    const copy = join(configDir, basename(original));
    await writeFile(copy, bytes, { mode: 0o600 });
    // The mode on `writeFile` applies only when it creates the file; a copy a
    // previous turn left keeps whatever mode the harness gave it.
    await chmod(copy, 0o600);
    seeded.push({ original, copy, seeded: bytes });
  }
  return seeded;
}

/** Shorter strings in a sign-in file are ids and flags, not credentials. */
const MIN_SECRET_LENGTH = 20;

function stringsOf(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    if (value.length >= MIN_SECRET_LENGTH) into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsOf(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) stringsOf(item, into);
  }
}

/**
 * The credentials a lent sign-in carries, for the run to scrub from what it
 * reports: every long string in a JSON file, or the whole of any other. The
 * harness can read its copy, so it can print it, or copy it into the checkout.
 */
export async function seededSecrets(profile: HarnessProfile): Promise<string[]> {
  const secrets: string[] = [];
  for (const path of profile.configSeed) {
    const text = await readFile(path, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    try {
      stringsOf(JSON.parse(text), secrets);
    } catch {
      if (text.trim().length >= MIN_SECRET_LENGTH) secrets.push(text.trim());
    }
  }
  return secrets;
}

/** Write back each copy the harness changed, over an original that has not. */
export async function returnSeededConfig(seeded: readonly SeededFile[]): Promise<void> {
  for (const file of seeded) {
    const now = await readFile(file.copy).catch(() => undefined);
    if (now === undefined || now.length === 0 || now.equals(file.seeded)) continue;
    const original = await readFile(file.original).catch(() => undefined);
    if (original?.equals(file.seeded) !== true) continue;
    const staged = join(dirname(file.original), `.${basename(file.original)}.aflow-${process.pid}`);
    await writeFile(staged, now, { mode: 0o600 });
    await rename(staged, file.original);
  }
}

/**
 * Run one turn of a harness with its sign-in lent to it. A profile that seeds
 * nothing runs `turn` as it is.
 */
export async function withSeededConfig<T>(
  profile: HarnessProfile,
  configDir: string | undefined,
  turn: () => Promise<T>,
): Promise<T> {
  if (profile.configSeed.length === 0 || configDir === undefined) return await turn();
  const lend = async (): Promise<T> => {
    const seeded = await seedConfig(profile, configDir);
    try {
      return await turn();
    } finally {
      await returnSeededConfig(seeded);
    }
  };
  if (!(await dueForRefresh(profile))) return await lend();
  return await serialized(profile.configSeed.join('\0'), lend);
}
