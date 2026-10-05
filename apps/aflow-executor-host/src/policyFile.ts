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
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const MODE = 0o600;

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

/** The process holding the lock, or nothing when it cannot be read. */
async function lockHolder(lockPath: string): Promise<number | undefined> {
  const text = await readFile(lockPath, 'utf8').catch(() => '');
  const pid = /^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** A lock its holder will never release: that process is gone, or it never said who it was. */
async function lockAbandoned(lockPath: string, holder: number | undefined): Promise<boolean> {
  if (holder !== undefined) return !processAlive(holder);
  const written = await stat(lockPath).catch(() => undefined);
  return written !== undefined && Date.now() - written.mtimeMs > POLICY_LOCK_WAIT_MS;
}

/**
 * Runs a read-modify-write of the policy file holding its lock, so two
 * changes — the command's and the executor's, or two of either — cannot both
 * read the old file and the second write lose the first. The lock is a file
 * beside the policy, created exclusively and naming its holder's process.
 */
export async function withPolicyLock<T>(policyPath: string, change: () => Promise<T>): Promise<T> {
  const lockPath = `${policyPath}.lock`;
  const deadline = Date.now() + POLICY_LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lockPath, String(process.pid), { mode: MODE, flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = await lockHolder(lockPath);
      if (await lockAbandoned(lockPath, holder)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new PolicyLockTimeout(holder);
      await new Promise((resolve) => setTimeout(resolve, POLICY_LOCK_RETRY_MS));
    }
  }
  try {
    return await change();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

/** The one way this tool serialises a policy, so both writers agree byte for byte. */
export function serializePolicy(policy: unknown): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}
