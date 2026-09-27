/**
 * Guard: what a surviving workspace still installs, and for whom.
 *
 * A workspace manifest is shared between editions, so it lists what both need.
 * Delete the files one edition needed and the dependency stays declared — the
 * public core installs a realtime-video SDK and an SMTP client nothing in it
 * imports. No import graph can see this: every remaining import resolves, and
 * the manifest is simply larger than the tree.
 *
 * Pinned rather than failed, because the cut removes them. The pin is what
 * makes a NEW one visible: a dependency joining this list is one the core
 * stopped needing, and one leaving it is one the core started needing.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildImporterIndex } from './importScan.js';
import { dependenciesWithoutSurvivingImporter } from './cutTransforms.js';
import { ownerOf, survivesCoreCut } from './ownershipLookup.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const tracked = execFileSync('git', ['ls-files'], {
  cwd: repoRoot,
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter((line) => line.trim() !== '');

const survives = (path: string): boolean => {
  const match = ownerOf(path);
  return match !== undefined && survivesCoreCut(match.owner);
};

const importers = buildImporterIndex(
  tracked.filter((file) => /\.(ts|tsx|mts|cts|mjs|js)$/.test(file) && !file.includes('/dist/')),
  (file) => readFileSync(join(repoRoot, file), 'utf-8'),
);

/** `workspace → dependencies no surviving file in it imports.` */
function strandedByWorkspace(): Array<[string, string[]]> {
  const found: Array<[string, string[]]> = [];
  for (const manifestPath of tracked.filter((file) =>
    /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file),
  )) {
    if (!survives(manifestPath)) continue;
    const workspace = manifestPath.slice(0, -'/package.json'.length);
    const pkg = JSON.parse(readFileSync(join(repoRoot, manifestPath), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };
    const local = new Map(
      [...importers].map(([name, files]): [string, string[]] => [
        name,
        files.filter((file) => file.startsWith(`${workspace}/`)),
      ]),
    );
    const stranded = dependenciesWithoutSurvivingImporter(
      Object.keys(pkg.dependencies ?? {}),
      local,
      survives,
    );
    if (stranded.length > 0) found.push([workspace, stranded]);
  }
  return found.sort(([a], [b]) => a.localeCompare(b));
}

describe('dependencies a surviving workspace no longer needs', () => {
  it('is reading manifests and imports', () => {
    // Without this a scanner that resolved nothing would report a clean tree.
    expect(importers.size).toBeGreaterThan(50);
    expect(importers.get('zod')?.length ?? 0).toBeGreaterThan(20);
  });

  it('leaves no surviving workspace declaring a dependency only cloud imports', () => {
    // Empty in both trees, and for the same reason rather than by coincidence: a
    // dependency is declared by the workspace that imports it, and the workspace
    // importing `livekit-server-sdk` and `nodemailer` is the hosted distribution,
    // which the cut deletes whole. Nothing is left to prune.
    //
    // This once listed three dependencies stranded in `packages/server-runtime`
    // and relied on the cut removing them. A list here again means a cloud-only
    // dependency has been declared in a workspace the core keeps — the shape the
    // split removed, and the one no import graph can see, because every import in
    // the uncut tree resolves and only the manifest is too large.
    //
    // The sibling test is what keeps this from passing vacuously.
    expect(strandedByWorkspace()).toEqual([]);
  });
});
