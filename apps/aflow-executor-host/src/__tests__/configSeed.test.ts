/**
 * Contract: a harness's sign-in is lent into the run and taken back (Plan 325
 * D4). A copy the harness refreshed replaces the operator's file only when that
 * file is still what was copied, and two runs seeded from a sign-in about to be
 * refreshed never hold it at once.
 */
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dueForRefresh, seededSecrets, withSeededConfig } from '../configSeed.js';
import { HarnessProfileError, HarnessProfileSchema } from '../harnessProfiles.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let base: string;
let original: string;
let configDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aflow-seed-'));
  original = join(base, 'auth.json');
  configDir = join(base, 'run-config');
  await writeFile(original, '{"token":"one"}');
  await mkdir(configDir);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function profile(refreshAgeMs?: number): ReturnType<typeof HarnessProfileSchema.parse> {
  return HarnessProfileSchema.parse({
    id: 'codex',
    executable: '/usr/local/bin/codex',
    configDirEnv: 'CODEX_HOME',
    configSeed: [original],
    ...(refreshAgeMs !== undefined ? { configSeedRefreshAgeMs: refreshAgeMs } : {}),
  });
}

describe('lending a sign-in to a run', () => {
  it('puts a private copy where the harness reads it, and leaves an untouched original alone', async () => {
    const before = await stat(original);
    await withSeededConfig(profile(), configDir, async () => {
      const copy = join(configDir, 'auth.json');
      expect(await readFile(copy, 'utf8')).toBe('{"token":"one"}');
      expect((await stat(copy)).mode & 0o777).toBe(0o600);
    });
    expect((await stat(original)).mtimeMs).toBe(before.mtimeMs);
  });

  it('writes a refreshed copy back, since the refresh spent the token the original names', async () => {
    await withSeededConfig(profile(), configDir, async () => {
      await writeFile(join(configDir, 'auth.json'), '{"token":"two"}');
    });
    expect(await readFile(original, 'utf8')).toBe('{"token":"two"}');
  });

  it("keeps an original the operator's own harness refreshed meanwhile", async () => {
    await withSeededConfig(profile(), configDir, async () => {
      await writeFile(original, '{"token":"operator"}');
      await writeFile(join(configDir, 'auth.json'), '{"token":"run"}');
    });
    expect(await readFile(original, 'utf8')).toBe('{"token":"operator"}');
  });

  it('copies afresh on every turn, so a later turn holds the newest sign-in', async () => {
    await withSeededConfig(profile(), configDir, async () => undefined);
    await writeFile(original, '{"token":"newer"}');
    await withSeededConfig(profile(), configDir, async () => {
      expect(await readFile(join(configDir, 'auth.json'), 'utf8')).toBe('{"token":"newer"}');
    });
  });

  it('refuses a run whose harness is not signed in, naming the file', async () => {
    await rm(original);
    await expect(withSeededConfig(profile(), configDir, async () => undefined)).rejects.toThrow(
      HarnessProfileError,
    );
    await expect(withSeededConfig(profile(), configDir, async () => undefined)).rejects.toThrow(
      original,
    );
  });

  it('serializes runs seeded from a sign-in old enough to be refreshed, and only those', async () => {
    const old = (Date.now() - 8 * DAY_MS) / 1000;
    await utimes(original, old, old);
    expect(await dueForRefresh(profile(7 * DAY_MS))).toBe(true);
    expect(await dueForRefresh(profile())).toBe(false);

    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withSeededConfig(profile(7 * DAY_MS), configDir, async () => {
      order.push('first started');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first ended');
    });
    const second = withSeededConfig(profile(7 * DAY_MS), configDir, async () => {
      order.push('second started');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first started']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first started', 'first ended', 'second started']);
  });

  it('lets runs seeded from a fresh sign-in overlap', async () => {
    const other = join(base, 'other-config');
    await mkdir(other);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withSeededConfig(profile(7 * DAY_MS), configDir, async () => {
      order.push('first started');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first ended');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await withSeededConfig(profile(7 * DAY_MS), other, async () => {
      order.push('second ran');
    });
    releaseFirst();
    await first;
    expect(order).toEqual(['first started', 'second ran', 'first ended']);
  });

  it('names every token the lent file holds, so the run scrubs them from what it reports', async () => {
    await writeFile(
      original,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'a'.repeat(40), refresh_token: 'r'.repeat(40) },
      }),
    );
    expect((await seededSecrets(profile())).sort()).toEqual(['a'.repeat(40), 'r'.repeat(40)]);
  });
});
