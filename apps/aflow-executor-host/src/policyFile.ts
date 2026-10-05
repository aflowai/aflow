/**
 * Replacing the policy file, rather than rewriting it in place.
 *
 * The policy is the machine's half of every binding, and the running executor
 * reloads it whenever it changes. A plain write is two observable states: a
 * truncated file, then a complete one. Interrupted between them — a crash, a
 * full disk, a ^C — it leaves JSON that parses as nothing, and the executor
 * that reloads it has no bindings at all. That reads as "the operator withdrew
 * everything" when what happened is a half-finished save.
 *
 * Writing a sibling and renaming makes the two states "old" and "new", which
 * are both answers. The sibling carries the mode from birth so the contents are
 * never briefly world-readable, and the directory handle is synced so the
 * rename itself survives a power cut rather than only the bytes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const MODE = 0o600;

/** Called by `editPolicy` alone, which holds the lock; a guard test fails on any other caller. */
export async function writePolicyAtomically(policyPath: string, contents: string): Promise<void> {
  await writeFileAtomically(policyPath, contents);
}

/**
 * The same replacement for any file the executor reads while it runs: a
 * browser request or its answer is never seen half-written either.
 */
export async function writeFileAtomically(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  // Same directory, so the rename is within one filesystem and therefore atomic.
  const temporary = join(
    dir,
    `.${basename(path)}.${String(process.pid)}.${Date.now().toString(36)}.tmp`,
  );
  try {
    await writeFile(temporary, contents, { mode: MODE, flag: 'wx' });
    const handle = await open(temporary, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const dirHandle = await open(dir, 'r').catch(() => null);
    if (dirHandle !== null) {
      try {
        await dirHandle.sync();
      } catch {
        // Not every filesystem lets a directory be synced, and the rename has
        // already happened. Nothing is gained by failing the save over it.
      } finally {
        await dirHandle.close();
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** How long a change waits for another to finish with the policy file before it gives up. */
export const POLICY_LOCK_WAIT_MS = 10_000;
const POLICY_LOCK_RETRY_MS = 20;

export class PolicyLockTimeout extends Error {
  constructor(holder: number | undefined) {
    super(
      `The host policy is being changed by ${
        holder === undefined ? 'another process' : `process ${String(holder)}`
      } and was not released within ${String(POLICY_LOCK_WAIT_MS / 1000)} seconds, so nothing ` +
        'was changed. Try again once it has finished.',
    );
    this.name = 'PolicyLockTimeout';
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What a lock says: its holder's process, and a token no other lock ever carries. */
async function readLock(lockPath: string): Promise<{ text: string; holder?: number } | undefined> {
  const text = await readFile(lockPath, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  const pid = Number(/^(\d+)(?: [0-9a-f-]+)?$/.exec(text.trim())?.[1] ?? Number.NaN);
  return Number.isInteger(pid) && pid > 0 ? { text, holder: pid } : { text };
}

/** A lock its holder will never release: that process is gone, or it never said who it was. */
async function lockAbandoned(lockPath: string, holder: number | undefined): Promise<boolean> {
  if (holder !== undefined) return !processAlive(holder);
  const written = await stat(lockPath).catch(() => undefined);
  return written !== undefined && Date.now() - written.mtimeMs > POLICY_LOCK_WAIT_MS;
}

/**
 * Removes the abandoned lock that read as `seen`, unless another waiter is
 * removing it or already has. Only the waiter that creates the marker named
 * for that lock may remove it, and every lock's text is unique, so a lock
 * read as abandoned is never mistaken for the one a live holder took since.
 */
async function takeOverAbandoned(lockPath: string, seen: string): Promise<void> {
  const marker = `${lockPath}.${createHash('sha256').update(seen).digest('hex').slice(0, 16)}`;
  try {
    await writeFile(marker, '', { mode: MODE, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A marker this old was left by a waiter that ended mid-takeover. Removing
    // it is safe: whoever creates the next one removes the lock only if it
    // still reads as `seen`, which no live holder's lock ever does.
    if (await lockAbandoned(marker, undefined)) await unlink(marker).catch(() => undefined);
    return;
  }
  try {
    if ((await readLock(lockPath))?.text === seen) await unlink(lockPath);
  } finally {
    await unlink(marker).catch(() => undefined);
  }
}

/** Holds the policy file's lock while `change` runs: a file beside it, created exclusively. */
async function withPolicyLock<T>(policyPath: string, change: () => Promise<T>): Promise<T> {
  const lockPath = `${policyPath}.lock`;
  const mine = `${String(process.pid)} ${randomUUID()}`;
  const deadline = Date.now() + POLICY_LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lockPath, mine, { mode: MODE, flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lock = await readLock(lockPath);
      if (lock === undefined) continue;
      if (await lockAbandoned(lockPath, lock.holder)) {
        await takeOverAbandoned(lockPath, lock.text);
        continue;
      }
      if (Date.now() >= deadline) throw new PolicyLockTimeout(lock.holder);
      await new Promise((resolve) => setTimeout(resolve, POLICY_LOCK_RETRY_MS));
    }
  }
  // A command that exits mid-change leaves no lock for the next one to wait on.
  const releaseOnExit = (): void => {
    try {
      if (readFileSync(lockPath, 'utf8') === mine) unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  };
  process.once('exit', releaseOnExit);
  try {
    return await change();
  } finally {
    process.off('exit', releaseOnExit);
    await unlink(lockPath).catch(() => undefined);
  }
}

/**
 * The one way anything reads, changes and writes the policy file, holding its
 * lock throughout, so two changes — the commands', the executor's, or two of
 * either — cannot both read the old file and the second write lose the first.
 * `change` is given the file's JSON, or nothing when there is no file yet, and
 * returns what to write, or nothing to leave the file as it is.
 */
export async function editPolicy<R extends object | undefined>(
  policyPath: string,
  change: (current: unknown) => R | Promise<R>,
): Promise<R> {
  return await withPolicyLock(policyPath, async () => {
    const text = await readFile(policyPath, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    const next = await change(text === undefined ? undefined : (JSON.parse(text) as unknown));
    if (next !== undefined) await writePolicyAtomically(policyPath, serializePolicy(next));
    return next;
  });
}

/** The one way this tool serialises a policy, so both writers agree byte for byte. */
export function serializePolicy(policy: unknown): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}
