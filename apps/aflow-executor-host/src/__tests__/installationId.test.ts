/**
 * The installation's identity: written to the host directory at the first
 * start, beside the policy, and read unchanged at every start after.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HOST_POLICY_FILE } from '../hostDir.js';
import { INSTALLATION_ID_FILE, loadInstallationId } from '../installationId.js';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'installation-id-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("an installation's identity", () => {
  it('is written once, readable by the operator alone, and the same at every start after', async () => {
    const first = await loadInstallationId(base);
    const path = join(base, INSTALLATION_ID_FILE);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadInstallationId(base)).toBe(first);
    expect((await readFile(path, 'utf8')).trim()).toBe(first);
    expect(await readdir(base)).toEqual([INSTALLATION_ID_FILE]);
  });

  it('is kept beside the policy, in a host directory not yet made', async () => {
    const hostDir = join(base, '.aflow');
    await loadInstallationId(hostDir);
    await writeFile(join(hostDir, HOST_POLICY_FILE), '{}');
    expect((await readdir(hostDir)).sort()).toEqual(
      [HOST_POLICY_FILE, INSTALLATION_ID_FILE].sort(),
    );
  });

  it('is one per installation, and one for executors starting together on the same', async () => {
    const other = join(base, 'other');
    const together = await Promise.all([loadInstallationId(base), loadInstallationId(base)]);

    expect(together[0]).toBe(together[1]);
    expect(await loadInstallationId(other)).not.toBe(together[0]);
  });

  it('is refused when the file holds something else, rather than replaced', async () => {
    const path = join(base, INSTALLATION_ID_FILE);
    await writeFile(path, 'laptop\n');

    await expect(loadInstallationId(base)).rejects.toThrow(/installation identity/);
    expect(await readFile(path, 'utf8')).toBe('laptop\n');
  });
});
