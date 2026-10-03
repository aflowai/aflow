/**
 * Whether a live Chrome holds a profile's directory, read from Chrome's own
 * singleton lock.
 */
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHROME_SINGLETON_LOCK,
  profileHolder,
  type ProfileLockDeps,
} from '../browser/profileLock.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aflow-profile-lock-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function machine(live: number[]): ProfileLockDeps {
  return {
    host: 'op-laptop.local',
    alive: (pid) => live.includes(pid),
    describe: (pid) =>
      pid === 4242
        ? { parentPid: 777, command: 'Google Chrome --user-data-dir=x' }
        : pid === 777
          ? { parentPid: 1, command: 'node dist/index.js' }
          : undefined,
  };
}

async function lock(target: string): Promise<void> {
  await symlink(target, join(dir, CHROME_SINGLETON_LOCK));
}

describe('the profile lock', () => {
  it('names the live Chrome holding the directory and the process that started it', async () => {
    await lock('op-laptop.local-4242');
    expect(await profileHolder(dir, machine([4242]))).toEqual({
      chromePid: 4242,
      startedBy: { pid: 777, command: 'node dist/index.js' },
    });
  });

  it('holds nothing when there is no lock, or the process it names is gone', async () => {
    expect(await profileHolder(dir, machine([4242]))).toBeUndefined();
    await lock('op-laptop.local-4242');
    expect(await profileHolder(dir, machine([]))).toBeUndefined();
  });

  it('does not judge a lock another machine wrote, or one it cannot read', async () => {
    await lock('other-host-4242');
    expect(await profileHolder(dir, machine([4242]))).toBeUndefined();
    await rm(join(dir, CHROME_SINGLETON_LOCK));
    await lock('nonsense');
    expect(await profileHolder(dir, machine([4242]))).toBeUndefined();
  });
});
