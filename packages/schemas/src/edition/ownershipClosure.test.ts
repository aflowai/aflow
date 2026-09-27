/**
 * Guard: no edition depends on a workspace its build will not contain.
 *
 * The manifest says which workspaces a public-core cut deletes. That is only
 * true if nothing surviving the cut reaches them, and the honest way to know is
 * the code rather than an assertion that it is so.
 *
 * Both halves are checked, because either alone can be satisfied while the
 * property is false. `package.json` is what a public repository must install,
 * so a missing declaration breaks the cut even when the import resolves; and
 * `nodeLinker: node-modules` symlinks every workspace into the root, so an
 * import resolves at build and runtime whether or not anything declared it.
 * Declaration and use are separate facts and each is a way through.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildImporterIndex } from './importScan.js';
import type { OwnershipClass } from './ownership.js';
import { ownerOf, survivesCoreCut } from './ownershipLookup.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function git(args: string[]): string[] {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((line) => line.trim() !== '');
}

interface Workspace {
  dir: string;
  name: string;
  owner: OwnershipClass;
  declared: string[];
}

const manifestPaths = git(['ls-files', '*/*/package.json']).filter(
  (line) => line.startsWith('apps/') || line.startsWith('packages/'),
);

const workspaces: Workspace[] = [];
/** A workspace the manifest does not classify cannot be reasoned about at all. */
const unclassified: string[] = [];

for (const manifestPath of manifestPaths) {
  const dir = manifestPath.replace(/\/package\.json$/, '');
  const pkg = JSON.parse(readFileSync(join(repoRoot, manifestPath), 'utf-8')) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const match = ownerOf(`${dir}/`);
  if (match === undefined || pkg.name === undefined) {
    unclassified.push(dir);
    continue;
  }
  workspaces.push({
    dir,
    name: pkg.name,
    owner: match.owner,
    declared: [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ].filter((d) => d.startsWith('@aflow/')),
  });
}

const byName = new Map(workspaces.map((w) => [w.name, w]));
const byDir = [...workspaces].sort((a, b) => b.dir.length - a.dir.length);

/**
 * Cross-workspace imports as written in source, not as declared in a manifest.
 *
 * Read through the shared scanner rather than a pattern of its own. A matcher
 * that only knew `from '@aflow/…'` missed every bare side-effect import, and
 * the repository already has one — `apps/web/src/app/layout.tsx` imports the
 * design system's stylesheet for effect alone. Both halves of this guard would
 * then have reported no edge at all, which is the shape that lets a broken core
 * tree through: nothing declared it, and nothing appeared to import it.
 */
function importedWorkspaces(): Array<{ from: Workspace; to: Workspace; file: string }> {
  const sources = git(['ls-files', '--', 'apps', 'packages']).filter(
    (file) =>
      /\.(?:m|c)?[jt]sx?$/.test(file) && !/\.test\.[jt]sx?$/.test(file) && !file.includes('/dist/'),
  );

  const index = buildImporterIndex(sources, (file) => readFileSync(join(repoRoot, file), 'utf-8'));

  const edges: Array<{ from: Workspace; to: Workspace; file: string }> = [];
  for (const [pkg, importers] of index) {
    const to = byName.get(pkg);
    if (to === undefined) continue;
    for (const file of importers) {
      const from = byDir.find((w) => file.startsWith(`${w.dir}/`));
      if (from === undefined || from.name === to.name) continue;
      edges.push({ from, to, file });
    }
  }
  return edges;
}

describe('workspace dependency closure', () => {
  it('classifies every workspace before reasoning about any of them', () => {
    // Skipping the undecidable case would let an unclassified workspace vanish
    // from the analysis rather than fail it.
    expect(unclassified).toEqual([]);
  });

  it('is reading the workspaces', () => {
    expect(workspaces.length).toBeGreaterThan(20);
  });

  it('never declares a dependency the cut deletes', () => {
    const violations: string[] = [];
    for (const workspace of workspaces) {
      if (!survivesCoreCut(workspace.owner)) continue;
      for (const dependency of workspace.declared) {
        const target = byName.get(dependency);
        if (target !== undefined && !survivesCoreCut(target.owner)) {
          violations.push(
            `${workspace.dir} (${workspace.owner}) declares ${target.dir} (${target.owner})`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  /**
   * A reference the cut is MEANT to break, and the only kind there can be.
   *
   * The crash reporter is absent from the public artifact by design (246d §6b),
   * and core loads it by name at runtime inside a `try` that treats absence as the
   * expected answer. The scanner reads a specifier and cannot tell that apart from
   * a static import, so the one case is named here rather than hidden by building
   * the string — a reader of this file should be able to see the coupling exists
   * and why it is safe.
   *
   * Bounded deliberately: one file, one target. A second entry means something
   * else started depending on a workspace the public core does not have, which is
   * the failure this guard is for.
   */
  const TOLERATED_RUNTIME_ABSENCE = [
    'packages/observability/src/crashReporting.ts -> @aflow/crash-reporter-sentry (cloud)',
  ];

  it('never imports a workspace the cut deletes', () => {
    const edges = importedWorkspaces();
    expect(edges.length).toBeGreaterThan(20);
    const violations = edges
      .filter((edge) => survivesCoreCut(edge.from.owner) && !survivesCoreCut(edge.to.owner))
      .map((edge) => `${edge.file} -> ${edge.to.name} (${edge.to.owner})`)
      .filter((violation) => !TOLERATED_RUNTIME_ABSENCE.includes(violation));
    expect(violations).toEqual([]);
  });

  it('never has a core workspace reach a local-only one', () => {
    // The same mistake in the other direction, and the one the hosted
    // deployment cannot notice, because everything is present there today.
    const violations = importedWorkspaces()
      .filter((edge) => edge.from.owner === 'core' && edge.to.owner === 'local')
      .map((edge) => `${edge.file} -> ${edge.to.name}`);
    expect(violations).toEqual([]);
  });
});
