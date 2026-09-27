/**
 * Guard: the run access grant lives in the session hot-state hash, and any
 * writer that creates that hash carries the grant inside its own write.
 *
 * `atomicCreateSession` and `setSessionState` both DEL the hash before writing
 * it, so a grant stored through `setRunAccessGrant` on either side of one of
 * those writes is discarded (before) or a wasted second roundtrip (after).
 * Storing it ahead of session creation is what made every run pause
 * unrecoverably once its gated work outlived the grant.
 *
 * `setRunAccessGrant` is therefore only valid against a hash that already
 * exists — the resume, retry, and step-scheduling paths. A module that creates
 * session hot state must embed `grantJson` in the literal instead.
 */
import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

/** Located by marker, not by counting `..` — the count silently resolves
 *  elsewhere when the module path differs, which reads as a guard failure. */
async function findRepoRoot(from: string): Promise<string> {
  let dir = from;
  const { root } = parse(dir);
  while (dir !== root) {
    try {
      await access(join(dir, 'yarn.lock'));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error(`repo root not found above ${from}`);
}

const repoRoot = await findRepoRoot(dirname(fileURLToPath(import.meta.url)));

const SEARCH_ROOTS = [
  join(repoRoot, 'apps/aflow-orchestrator/src'),
  join(repoRoot, 'packages/server-runtime/src'),
  join(repoRoot, 'apps/server/src'),
];

const CREATES_SESSION_STATE = /\b(atomicCreateSession|setSessionState)\s*\(/;
const STORES_GRANT = /\bsetRunAccessGrant\s*\(/;

async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...(await collectSourceFiles(full)));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.includes('.test.') || entry.name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('run access grant storage consolidation', () => {
  it('no module both creates session hot state and separately stores the grant', async () => {
    const offenders: string[] = [];
    for (const root of SEARCH_ROOTS) {
      const sources = await collectSourceFiles(root);
      // An empty sweep would pass vacuously — the guard must fail loudly if it
      // is ever pointed at the wrong tree.
      expect(sources.length).toBeGreaterThan(0);
      for (const file of sources) {
        const src = await readFile(file, 'utf-8');
        if (CREATES_SESSION_STATE.test(src) && STORES_GRANT.test(src)) {
          offenders.push(file.slice(repoRoot.length + 1));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('startRun carries the compiled grant in the session it creates', async () => {
    const src = await readFile(
      join(
        repoRoot,
        'apps/aflow-orchestrator/src/services/SessionOrchestrator/lifecycle/startRun.ts',
      ),
      'utf-8',
    );
    // Without this the run starts grantless and every gated step pays a
    // recompile — silently, because the scheduler renews rather than pauses.
    expect(src).toMatch(/grantJson:\s*serializeRunAccessGrant\(/);
  });

  it('startRun carries a grant the QUEUED session already held', async () => {
    const src = await readFile(
      join(
        repoRoot,
        'apps/aflow-orchestrator/src/services/SessionOrchestrator/lifecycle/startRun.ts',
      ),
      'utf-8',
    );
    // QUEUED→RUNNING re-creates the hash, so a grant that arrived with the
    // QUEUED literal and cannot be recompiled here — an eval trial's inherited
    // read-only grant — is lost unless this fallback carries it forward.
    expect(src).toMatch(/existingRun\?\.grantJson\s*\?\s*parseRunAccessGrant\(/);
  });
});
