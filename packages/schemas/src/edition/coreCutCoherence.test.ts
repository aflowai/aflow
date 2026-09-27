/**
 * Guard: the core cut leaves no dangling import.
 *
 * The manifest says which paths a public-core cut deletes. Deleting them is
 * only safe if nothing left behind still points at them, and the last time
 * this cut was actually run the set turned out to be necessary but not
 * sufficient: removing exactly the enterprise modules left *test* files
 * importing things that no longer existed.
 *
 * This resolves every relative import in every surviving file and checks the
 * target survives too. It is the cheap half of the release proof in §5a — the
 * expensive half builds and tests the cut for real — and it runs in the normal
 * suite because a dangling import is cheaper to learn about here than in a
 * release job.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CUT_REACHES_PENDING_EXTRACTION } from './ownership.js';
import { ownerOf, survivesCoreCut } from './ownershipLookup.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function manifestPaths(): string[] {
  return tracked(/^(?:apps|packages)\/[^/]+\/package\.json$/);
}

function tracked(pattern = /\.(ts|tsx|mts|cts)$/): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter((line) => pattern.test(line));
}

/**
 * Where a specifier points, repo-relative, or undefined if it points outside
 * this tree.
 *
 * Relative specifiers resolve against the importing file. `@/…` is the web
 * app's tsconfig alias for `apps/web/src/…` — invisible to a relative-only
 * matcher, and the web app reaches almost everything through it, so the guard
 * saw one import in every page and none of the rest.
 */
function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    return posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  }
  if (specifier.startsWith('@/') && fromFile.startsWith('apps/web/')) {
    return posix.join('apps/web/src', specifier.slice(2));
  }
  return workspaceSubpath(specifier);
}

/**
 * Where a `@aflow/x/subpath` import lands, read from that package's own
 * `exports` map.
 *
 * A subpath export is how a package publishes one module without putting it in
 * the barrel, which is exactly what an implementation behind a port wants — so
 * it is also how a surviving file comes to name a deleted one without a
 * relative path anywhere. Moving the Auth0 management client behind such an
 * export is what found this: nothing here saw the reach, and the cut failed on
 * a module that was gone.
 */
function workspaceSubpath(specifier: string): string | undefined {
  const match = /^(@aflow\/[^/]+)\/(.+)$/.exec(specifier);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const workspace = WORKSPACE_DIRS.get(match[1]);
  if (workspace === undefined) return undefined;
  const source = EXPORTS.get(match[1])?.[`./${match[2]}`];
  return source === undefined
    ? undefined
    : posix.normalize(posix.join(workspace, source.replace(/^\.\//, '')));
}

/**
 * The specifier forms this guard resolves: relative, the web app's `@/` alias,
 * and a `@aflow/x/subpath` workspace export.
 *
 * Named once because it is used three times. Widening it to cover subpath
 * exports while two call sites kept their own copy is exactly how the reach
 * that prompted it stayed invisible.
 */
const RESOLVABLE = String.raw`(?:\.|@\/|@aflow\/)[^']+`;
const specifierPattern = (): RegExp =>
  new RegExp(
    `from\\s+'(${RESOLVABLE})'|import\\s+'(${RESOLVABLE})'|import\\(\\s*'(${RESOLVABLE})'\\s*\\)`,
    'g',
  );

/** Every spelling a TypeScript source path can resolve to. */
function candidates(base: string): string[] {
  const withoutJs = base.replace(/\.js$/, '');
  return [
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    `${withoutJs}/index.ts`,
    `${withoutJs}/index.tsx`,
    base,
  ];
}

/** `@aflow/x` → the directory holding it, and its `ts-source` export map. */
const WORKSPACE_DIRS = new Map<string, string>();
const EXPORTS = new Map<string, Record<string, string>>();
for (const manifest of tracked().length > 0 ? manifestPaths() : []) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, manifest), 'utf-8')) as {
    name?: string;
    exports?: Record<string, Record<string, string>>;
  };
  if (pkg.name === undefined) continue;
  WORKSPACE_DIRS.set(pkg.name, manifest.slice(0, -'/package.json'.length));
  const sources: Record<string, string> = {};
  for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
    const source = conditions['ts-source'];
    if (source !== undefined) sources[subpath] = source;
  }
  EXPORTS.set(pkg.name, sources);
}

describe('core cut coherence', () => {
  const files = tracked();
  const present = new Set(files);
  const surviving = files.filter((file) => {
    const match = ownerOf(file);
    return match !== undefined && survivesCoreCut(match.owner);
  });

  it('is reading the source tree', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(surviving.length).toBeGreaterThan(1000);
  });

  it('leaves no surviving file importing one the cut deletes', () => {
    const pending = new Set(CUT_REACHES_PENDING_EXTRACTION.map((entry) => entry.from));
    const dangling: string[] = [];
    for (const file of surviving) {
      if (pending.has(file)) continue;
      const source = readFileSync(join(repoRoot, file), 'utf-8');
      const dir = posix.dirname(file);
      // `from '…'`, a bare side-effect `import '…'`, and `import('…')`. The
      // bare form has no `from` and was invisible to an earlier matcher, which
      // a planted import proved before this line existed.
      //
      // `import type` counts, and the reason is worth keeping: esbuild erases
      // it, so the bundle does not need the file — but `tsc` still resolves it
      // to emit declarations, and the cut runs a typecheck. Skipping type
      // imports made this guard green while the real cut failed on exactly one
      // of them.
      for (const match of source.matchAll(specifierPattern())) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (specifier === undefined) continue;
        const resolved = resolveSpecifier(file, specifier);
        if (resolved === undefined) continue;
        const target = candidates(resolved).find((c) => present.has(c));
        // Unresolvable means a type-only path, a directory re-export this
        // matcher does not model, or a file outside git. Only a target that
        // exists and does not survive is a finding.
        if (target === undefined) continue;
        const owner = ownerOf(target);
        if (owner !== undefined && !survivesCoreCut(owner.owner)) {
          dangling.push(`${file} -> ${target} (${owner.owner})`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  it('resolves enough imports to be meaningful', () => {
    // Without this, a matcher that resolved nothing would report a coherent
    // cut. Counts resolved targets rather than findings.
    let resolved = 0;
    for (const file of surviving.slice(0, 400)) {
      const source = readFileSync(join(repoRoot, file), 'utf-8');
      const dir = posix.dirname(file);
      for (const match of source.matchAll(specifierPattern())) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        const target = resolveSpecifier(file, specifier);
        if (target !== undefined && candidates(target).some((c) => present.has(c))) {
          resolved++;
        }
      }
    }
    expect(resolved).toBeGreaterThan(500);
  });
  it('names only files that still reach across the cut', () => {
    // Checking the file exists would excuse it forever: the entry survives its
    // own fix. This resolves the imports again and keeps an entry only while it
    // still reaches something the cut deletes, so the list empties itself.
    const stale: string[] = [];
    for (const entry of CUT_REACHES_PENDING_EXTRACTION) {
      if (!present.has(entry.from)) {
        stale.push(entry.from);
        continue;
      }
      const source = readFileSync(join(repoRoot, entry.from), 'utf-8');
      const dir = posix.dirname(entry.from);
      let reaches = false;
      for (const match of source.matchAll(specifierPattern())) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (specifier === undefined) continue;
        const resolved = resolveSpecifier(entry.from, specifier);
        if (resolved === undefined) continue;
        const target = candidates(resolved).find((c) => present.has(c));
        if (target === undefined) continue;
        const owner = ownerOf(target);
        if (owner !== undefined && !survivesCoreCut(owner.owner)) reaches = true;
      }
      if (!reaches) stale.push(entry.from);
    }
    expect(stale).toEqual([]);
  });
});
