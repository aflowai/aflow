/**
 * Whether a live Chrome already has a profile's directory open.
 *
 * Chrome keeps `SingletonLock` in the directory while it runs: a symbolic link
 * whose target is `<host>-<pid>`. Chrome allows one process per directory, so
 * a second started on it would hand its work to the first or fail — and the
 * command line acting alone on a profile the executor's Chrome holds would
 * show the operator a window on the executor's browser. A lock left by a
 * Chrome that crashed names a process that is gone, and holds nothing.
 */
import { readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { describeProcess } from '../orphans.js';

export const CHROME_SINGLETON_LOCK = 'SingletonLock';

export interface ProcessInfo {
  readonly parentPid: number;
  readonly command: string;
}

export interface ProfileHolder {
  readonly chromePid: number;
  /** The process that started that Chrome, when it could be read. */
  readonly startedBy?: { readonly pid: number; readonly command: string };
}

export interface ProfileLockDeps {
  readonly host: string;
  alive(pid: number): boolean;
  describe(pid: number): ProcessInfo | undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const systemProfileLock: ProfileLockDeps = {
  host: hostname(),
  alive: processAlive,
  describe: describeProcess,
};

/** The live Chrome holding `userDataDir` on this machine, or nothing when none does. */
export async function profileHolder(
  userDataDir: string,
  deps: ProfileLockDeps = systemProfileLock,
): Promise<ProfileHolder | undefined> {
  const target = await readlink(join(userDataDir, CHROME_SINGLETON_LOCK)).catch(() => undefined);
  if (target === undefined) return undefined;
  const cut = target.lastIndexOf('-');
  const host = target.slice(0, cut);
  const chromePid = Number(target.slice(cut + 1));
  if (cut <= 0 || host !== deps.host || !Number.isInteger(chromePid) || chromePid <= 1) {
    return undefined;
  }
  if (!deps.alive(chromePid)) return undefined;
  const chrome = deps.describe(chromePid);
  const parent = chrome === undefined ? undefined : deps.describe(chrome.parentPid);
  return {
    chromePid,
    ...(chrome !== undefined && parent !== undefined
      ? { startedBy: { pid: chrome.parentPid, command: parent.command } }
      : {}),
  };
}
