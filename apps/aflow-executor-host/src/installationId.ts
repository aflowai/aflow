/**
 * This executor installation's own identity, for what it keeps in shared Redis
 * that must outlive its restarts and never be taken for another's.
 *
 * Neither name the executor already has will do. The OS's name for the machine
 * is shared by two paired machines that happen to carry it, and by two
 * executors on one machine; the executor's own name falls back to one carrying
 * its pid, which a restart changes. So the host directory keeps one, written at
 * the first start and read at every start after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const INSTALLATION_ID_FILE = 'installation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function errorCode(error: unknown): unknown {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

/** The identity in `hostDir`, written there first when there is none. */
export async function loadInstallationId(hostDir: string): Promise<string> {
  const path = join(hostDir, INSTALLATION_ID_FILE);
  await mkdir(hostDir, { recursive: true, mode: 0o700 });
  // Written whole beside the file and linked into place, which fails when the
  // file exists: two executors starting together on one directory agree on
  // whichever landed first, and neither ever reads one half written.
  const draft = `${path}.${randomBytes(6).toString('hex')}`;
  await writeFile(draft, `${randomUUID()}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await link(draft, path);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  } finally {
    await unlink(draft).catch(() => undefined);
  }
  const id = (await readFile(path, 'utf8')).trim();
  if (!UUID.test(id)) {
    throw new Error(
      `${path} should hold this executor's installation identity and does not. Remove it and ` +
        'start the executor again; a new one is written, and the browser hand-offs the old one ' +
        'left in the Action Center go when they expire.',
    );
  }
  return id;
}
