/**
 * The packages a Next application reads from `dist`, and which of them are
 * older than their source.
 *
 * Every Node service resolves `@aflow/*` through the `ts-source` condition and
 * reads `src`. A Next application's bundler resolves the `import` condition, so
 * it reads what the last build wrote, and a package edited or merged since is
 * served as it was — the failure is a missing export naming a symbol the source
 * plainly has.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WORKSPACE_GROUPS = ['apps', 'packages'];
const SOURCE_DIR = 'src';
const DIST_DIR = 'dist';
const RUNTIME_DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const SCOPE = '@aflow/';
const NEXT_PACKAGE = 'next';

/** Neither is in what the build writes, so neither makes it older than its source. */
const NOT_BUILT = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|\.tsbuildinfo)$/;

/** Every workspace under `apps/` and `packages/`, by package name. */
export function readWorkspaces(repoRoot) {
  const byName = new Map();
  for (const group of WORKSPACE_GROUPS) {
    const base = join(repoRoot, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const dir = join(base, entry);
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (typeof manifest.name !== 'string') continue;
      byName.set(manifest.name, { name: manifest.name, dir, manifest });
    }
  }
  return byName;
}

export function isNextApplication(workspace) {
  return workspace?.manifest.dependencies?.[NEXT_PACKAGE] !== undefined;
}

function workspaceDependencies(workspace, workspaces) {
  return RUNTIME_DEPENDENCY_FIELDS.flatMap((field) =>
    Object.keys(workspace.manifest[field] ?? {}),
  ).filter((name) => name.startsWith(SCOPE) && workspaces.has(name));
}

/**
 * The workspace packages the consumers reach through their runtime
 * dependencies, transitively, each after everything it depends on — the order
 * they can be built in.
 */
export function distClosure(workspaces, consumers) {
  const ordered = [];
  const visited = new Set(consumers);
  const visit = (name) => {
    for (const dependency of workspaceDependencies(workspaces.get(name), workspaces)) {
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      visit(dependency);
      ordered.push(dependency);
    }
  };
  for (const consumer of consumers) visit(consumer);
  return ordered;
}

/** The files the `import` condition resolves to, which only a build writes. */
function importTargets(manifest) {
  const exported = manifest.exports;
  const entries =
    exported === undefined
      ? [manifest.module ?? manifest.main]
      : typeof exported === 'string'
        ? [exported]
        : Object.values(exported).map((target) =>
            typeof target === 'string' ? target : (target?.import?.default ?? target?.import),
          );
  return entries.filter(
    (target) =>
      typeof target === 'string' && target.startsWith(`./${DIST_DIR}/`) && !target.includes('*'),
  );
}

/** The newest modification time under a directory, or 0 where it has nothing. */
export function newestSourceMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || NOT_BUILT.test(entry.name)) continue;
    const mtime = statSync(join(entry.parentPath, entry.name)).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

function fileMtime(file) {
  return existsSync(file) ? statSync(file).mtimeMs : undefined;
}

/**
 * @typedef {object} Measure Where the times come from; the file system unless a test says otherwise.
 * @property {(dir: string) => number} [sourceMtime]
 * @property {(file: string) => number | undefined} [builtMtime]
 */

/**
 * Why a package's build is older than its source, or null when it is current.
 *
 * Measured against the files the `import` condition names rather than all of
 * `dist`: a type-check writes declarations there without touching the
 * JavaScript, which would make a stale build look current.
 *
 * @param {Measure} [measure]
 */
export function distStaleness(workspace, measure = {}) {
  const sourceMtime = measure.sourceMtime ?? newestSourceMtime;
  const builtMtime = measure.builtMtime ?? fileMtime;
  const targets = importTargets(workspace.manifest);
  if (targets.length === 0 || workspace.manifest.scripts?.build === undefined) return null;
  const built = targets.map((target) => builtMtime(join(workspace.dir, target)));
  if (built.some((mtime) => mtime === undefined)) return `${DIST_DIR}/ is missing`;
  const oldest = Math.min(...built);
  const newest = sourceMtime(join(workspace.dir, SOURCE_DIR));
  if (newest <= oldest) return null;
  return `${SOURCE_DIR}/ is ${String(Math.round((newest - oldest) / 1000))}s newer than ${DIST_DIR}/`;
}

/**
 * What a start rebuilds before its Next applications serve: every package in
 * their dist closure whose build is older than its source, apart from the ones
 * the start already runs a watcher for, whose first build happens as it starts.
 *
 * @param {{ workspaces: Map<string, unknown>, consumers: string[], watched?: string[], measure?: Measure }} selection
 */
export function selectDistRebuilds(selection) {
  const { workspaces, consumers } = selection;
  const watched = selection.watched ?? [];
  const rebuild = [];
  const watchedStale = [];
  for (const name of distClosure(workspaces, consumers)) {
    const reason = distStaleness(workspaces.get(name), selection.measure);
    if (reason === null) continue;
    (watched.includes(name) ? watchedStale : rebuild).push({ name, reason });
  }
  return { rebuild, watchedStale };
}
