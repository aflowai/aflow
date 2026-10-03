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
import { open, rename, unlink, writeFile } from 'node:fs/promises';
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

/** The one way this tool serialises a policy, so both writers agree byte for byte. */
export function serializePolicy(policy: unknown): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}
