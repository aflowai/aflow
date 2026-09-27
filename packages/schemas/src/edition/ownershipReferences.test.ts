/**
 * Guard: a surviving config may not name a path the cut deletes.
 *
 * The import-level guards see TypeScript and nothing else. A Compose file
 * naming a script, a Dockerfile copying a directory and a package.json script
 * invoking a path are all references the cut can break, and none of them is an
 * import — so the cut stays green through typecheck and fails when somebody
 * boots the product.
 *
 * That is not hypothetical. `scripts/release.mjs` was classified `cloud` on
 * the strength of its name; the appliance's own migrate service runs it to
 * bring the database up before the API starts, so the cut deleted a script the
 * local product needs to boot, and every other guard passed.
 *
 * A reference the cut removes is not a violation, and the transform that
 * removes it is the one `scripts/core-cut.mjs` runs — imported, not restated,
 * because a guard describing a transformation is a guard that can be wrong
 * about it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  pruneDockerfile,
  pruneScripts,
  pruneWorkspaceManifest,
  workspaceOf,
} from './cutTransforms.js';
import { CUT_REFERENCES_PENDING_EXTRACTION } from './ownership.js';
import { ownerOf, survivesCoreCut } from './ownershipLookup.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Configuration that names paths, and is itself classified. */
const CONFIGS = [
  'docker-compose.local.yml',
  'docker-compose.yml',
  'Dockerfile',
  'package.json',
  '.github/workflows/ci.yml',
  '.github/workflows/edition-seam.yml',
  '.github/workflows/deploy-gcp.yml',
  '.github/workflows/appliance-image.yml',
  'Procfile',
  'app.json',
  'heroku.yml',
  'cloudbuild.yaml',
  // Runners are configuration that happens to be executable: each decides
  // which workspace a named service starts, and neither imports one.
  'scripts/prod-launcher.mjs',
  'scripts/dev.mjs',
];

/**
 * Repo-relative paths a config mentions, as literal text.
 *
 * Build output resolves to the workspace that produces it. `dist` is not
 * tracked, so a launcher naming `apps/aflow-executor-code/dist/index.js` would
 * otherwise name nothing the cut could be said to delete — while starting a
 * workspace that is no longer there.
 */
function referencedPaths(source: string): string[] {
  const found = new Set<string>();
  // A path named in a comment is not a path anything runs. The Dockerfile
  // explains why the worker profile drops back to root by pointing at the
  // script that does it, and a public core carrying the sentence without the
  // script is untidy rather than broken.
  const executable = source
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/|\*|\/\*)/.test(line))
    .join('\n');
  for (const match of executable.matchAll(/(?:scripts|apps|packages)\/[A-Za-z0-9._/-]+/g)) {
    const raw = match[0].replace(/[.,'")]+$/, '');
    found.add(raw);
    const build = /^((?:apps|packages)\/[^/]+)\/(?:dist|\.next)\//.exec(raw);
    if (build?.[1] !== undefined) found.add(`${build[1]}/package.json`);
  }
  return [...found];
}

describe('ownership of paths named by configuration', () => {
  const tracked = new Set(
    execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\n')
      .filter((line) => line.trim() !== ''),
  );

  it('is reading configuration that names paths', () => {
    const total = CONFIGS.filter((c) => tracked.has(c)).reduce(
      (sum, config) => sum + referencedPaths(readFileSync(join(repoRoot, config), 'utf-8')).length,
      0,
    );
    expect(total).toBeGreaterThan(20);
  });

  /** What the config looks like after the cut has transformed it. */
  function cutContent(config: string): string {
    const source = readFileSync(join(repoRoot, config), 'utf-8');
    const deleted = [...tracked].filter((path) => {
      const owner = ownerOf(path);
      return owner !== undefined && !survivesCoreCut(owner.owner);
    });
    if (config === 'Dockerfile') {
      const workspaces = new Set(
        deleted.map(workspaceOf).filter(
          (workspace): workspace is string =>
            workspace !== undefined &&
            ![...tracked].some((path) => {
              if (!path.startsWith(`${workspace}/`)) return false;
              const owner = ownerOf(path);
              return owner !== undefined && survivesCoreCut(owner.owner);
            }),
        ),
      );
      return pruneDockerfile(source, workspaces).kept;
    }
    if (config === 'package.json') {
      const pkg = JSON.parse(source) as { scripts?: Record<string, string> };
      const { kept } = pruneScripts(pkg.scripts ?? {}, deleted);
      return JSON.stringify({ ...pkg, scripts: kept });
    }
    return source;
  }

  it('never publishes a subpath whose source the cut deletes', () => {
    // A workspace manifest names modules two ways that no other guard sees: an
    // `exports` subpath through its `ts-source` condition, and a bundler entry
    // as a script argument. Neither is an import, and neither is a
    // repo-relative path, so `referencedPaths` above does not find them either.
    const removed = new Set(
      [...tracked].filter((path) => {
        const owner = ownerOf(path);
        return owner !== undefined && !survivesCoreCut(owner.owner);
      }),
    );

    const violations: string[] = [];
    for (const manifestPath of [...tracked].filter((path) =>
      /^(?:apps|packages)\/[^/]+\/package\.json$/.test(path),
    )) {
      const owner = ownerOf(manifestPath);
      if (owner === undefined || !survivesCoreCut(owner.owner)) continue;
      const workspace = manifestPath.slice(0, -'/package.json'.length);
      const manifest = JSON.parse(readFileSync(join(repoRoot, manifestPath), 'utf-8')) as Record<
        string,
        unknown
      >;

      const cut = pruneWorkspaceManifest(manifest, workspace, removed);
      const exportsMap = cut.manifest['exports'];
      if (exportsMap === null || typeof exportsMap !== 'object' || Array.isArray(exportsMap)) {
        continue;
      }
      for (const [subpath, target] of Object.entries(exportsMap)) {
        const named = JSON.stringify(target);
        for (const path of removed) {
          const relative = path.startsWith(`${workspace}/`)
            ? path.slice(workspace.length + 1)
            : undefined;
          if (relative !== undefined && named.includes(relative)) {
            violations.push(`${manifestPath} publishes ${subpath} naming ${path}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('reports a script naming a deleted path without rewriting it', () => {
    // Pruning those arguments looked like the matching fix for the `exports`
    // one. A script that picks the widest root its artifact contains by testing
    // for the path makes the reference the mechanism rather than a mistake — and
    // rewriting it yields `[ -f ]` and an appliance that starts nothing, through
    // a script no install or typecheck runs.
    //
    // Synthetic on purpose. Pointing this at whichever real workspace happened
    // to hold such a script made the guard fail when that workspace changed,
    // which says nothing about the function under test.
    const guarded =
      '"$([ -f src/index.hosted.ts ] && echo src/index.hosted.ts || echo src/index.ts)"';
    const manifest: Record<string, unknown> = {
      name: '@aflow/synthetic',
      scripts: { dev: `tsx watch ${guarded}`, build: 'npx tsup' },
    };
    const cut = pruneWorkspaceManifest(manifest, 'apps/synthetic', [
      'apps/synthetic/src/index.hosted.ts',
    ]);

    expect(cut.scriptsNamingRemoved.map((entry) => entry.script)).toContain('dev');
    expect((cut.manifest['scripts'] as Record<string, string>)['dev']).toBe(
      (manifest['scripts'] as Record<string, string>)['dev'],
    );
  });

  it('never has a surviving config name a path the cut deletes', () => {
    const pending = new Set(CUT_REFERENCES_PENDING_EXTRACTION.map((entry) => entry.from));
    const violations: string[] = [];
    for (const config of CONFIGS) {
      if (!tracked.has(config) || pending.has(config)) continue;
      const configOwner = ownerOf(config);
      if (configOwner === undefined || !survivesCoreCut(configOwner.owner)) continue;

      for (const reference of referencedPaths(cutContent(config))) {
        // Only real files. A reference can be a prefix, a glob or a path built
        // at runtime, and those say nothing about what the cut removes.
        if (!tracked.has(reference)) continue;
        const target = ownerOf(reference);
        if (target !== undefined && !survivesCoreCut(target.owner)) {
          violations.push(`${config} (${configOwner.owner}) names ${reference} (${target.owner})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('names only configuration that still reaches across the cut', () => {
    const stale = CUT_REFERENCES_PENDING_EXTRACTION.filter((entry) => {
      if (!tracked.has(entry.from)) return true;
      // Still pending only while it genuinely names something the cut removes
      // AND no transform takes it away — an entry the cut already handles is a
      // carve-out that has outlived its reason.
      return !referencedPaths(cutContent(entry.from)).some((reference) => {
        if (!tracked.has(reference)) return false;
        const target = ownerOf(reference);
        return target !== undefined && !survivesCoreCut(target.owner);
      });
    }).map((entry) => entry.from);
    expect(stale).toEqual([]);
  });
});
