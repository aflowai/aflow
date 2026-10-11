/**
 * The check's side of the build cache the host executor keeps
 * (`apps/aflow-executor-host/src/checkBuildCache.ts`).
 *
 * The check writes no cache and is given no path to one. It reports, in the
 * file `AFLOW_CHECK_REPORT` names, every package it builds or is handed, what
 * each is built after, and the files each build wrote; the executor keeps
 * those builds once the check has exited, under keys it computes itself. Before
 * a later check it copies into the checkout every build whose key that commit
 * reproduces, and lists them in the file `AFLOW_CHECK_KEPT_BUILDS` names with
 * the graph each was keyed over. That graph is the word of the check that
 * reported it, so a build is taken only where this check reads the same graph;
 * any other is removed from the checkout and built.
 */
import { lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/** Names the file listing the builds the executor copied into this checkout. */
export const CHECK_KEPT_BUILDS_ENV = 'AFLOW_CHECK_KEPT_BUILDS';

/** Installations a build reads and never writes. */
const NOT_BUILD_OUTPUT = 'node_modules';

/** Every file under `dir` but its installations, relative, with when each last changed. */
export function snapshotFiles(dir) {
  const files = new Map();
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      if (entry.name === NOT_BUILD_OUTPUT) continue;
      const file = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.set(file, lstatSync(path.join(dir, file)).mtimeMs);
    }
  };
  walk('');
  return files;
}

/** What a build wrote under `dir`: files that are new since `before`, or changed. */
export function filesWritten(dir, before) {
  return [...snapshotFiles(dir)]
    .filter(([file, changedAt]) => before.get(file) !== changedAt)
    .map(([file]) => file)
    .sort();
}

/** The builds the executor handed this checkout, by package directory; none where it named no list. */
export function readKeptBuilds(file) {
  const kept = new Map();
  if (file === undefined || file === '') return kept;
  let listed;
  try {
    listed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return kept;
  }
  if (!Array.isArray(listed)) return kept;
  for (const build of listed) {
    if (
      typeof build?.dir === 'string' &&
      Array.isArray(build.graph) &&
      Array.isArray(build.files)
    ) {
      kept.set(build.dir, build);
    }
  }
  return kept;
}

/**
 * Whether `graph` — pairs of a package directory and the directories it is
 * built after — is exactly `dir` and everything it is built after as
 * `afterOf` reads this commit, so a build keyed over it is this commit's.
 */
export function sameGraph(graph, dir, afterOf) {
  const kept = new Map(graph.map(([keptDir, after]) => [keptDir, [...after].sort().join('\n')]));
  const seen = new Set();
  const pending = [dir];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (seen.has(current)) continue;
    seen.add(current);
    const after = afterOf(current);
    if (after === undefined || kept.get(current) !== [...after].sort().join('\n')) return false;
    pending.push(...after);
  }
  return seen.size === kept.size;
}

/** Take a handed build back out of the package, so the build runs on a package holding none of it. */
export function removeKeptBuild(packageDir, files) {
  for (const file of files) rmSync(path.join(packageDir, file), { force: true });
}
