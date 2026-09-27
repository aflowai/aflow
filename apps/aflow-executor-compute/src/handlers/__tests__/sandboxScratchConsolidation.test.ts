/**
 * Guard: all sandbox scratch dirs go through sandboxHostDir.ts.
 *
 * The compute substrate's load-bearing invariant (see sandboxHostDir.ts) is that
 * any host dir bind-mounted into a sandbox must resolve to the same path for the
 * host Docker daemon. A raw `os.tmpdir()` path breaks that under Docker-in-Docker
 * (the "hydrated but empty" bug). To keep one mental model — and stop a future
 * bind-mount from reintroducing the bug by copy-pasting a nearby `tmpdir()` call —
 * `sandboxHostDir.ts` is the ONLY handler allowed to reference `tmpdir()`; every
 * other handler must build scratch via `sandboxScratchDir()`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const handlersDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('sandbox scratch consolidation (DinD invariant guard)', () => {
  it('no handler constructs scratch via os.tmpdir() — use sandboxScratchDir()', async () => {
    const entries = await readdir(handlersDir, { withFileTypes: true });
    const offenders: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      // sandboxHostDir.ts is the single sanctioned home of the tmpdir() fallback.
      if (entry.name === 'sandboxHostDir.ts') continue;
      const src = await readFile(join(handlersDir, entry.name), 'utf-8');
      if (/\btmpdir\s*\(/.test(src)) offenders.push(entry.name);
    }
    expect(offenders).toEqual([]);
  });
});
