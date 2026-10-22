/**
 * A checkout's installed dependencies.
 *
 * A run's checkout carries only what the repository tracks, so the folder's
 * installations are mirrored into it as links (`linkDependencies`) and taken
 * out again without following any of them (`unlinkDependencies`). Everything
 * here is filesystem work: no git runs, so nothing the repository configures
 * can execute through it.
 */
import type { Dirent } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rmdir, symlink, unlink } from 'node:fs/promises';
import { dirname, join, relative as relativePath, sep } from 'node:path';

import type { Checkout } from './worktree.js';

/**
 * The directory a checkout inherits rather than fetches again.
 *
 * A checkout is created at a commit, so it carries what the repository tracks
 * and nothing else — and installed dependencies are, correctly, not tracked. A
 * harness asked to run the tests or the typecheck therefore reaches for the
 * package registry, which the boundary denies, and reports a network failure
 * for work the operator's own machine could already do. Linking the folder's
 * installation in is what makes the checkout runnable.
 *
 * By directory name, with no ecosystem named anywhere: which manifest put it
 * there, and whether it is one package or a workspace, is none of this lane's
 * business.
 */
const DEPENDENCY_DIR = 'node_modules';

/**
 * How far down the folder is searched. A workspace keeps one installation at
 * the root and one per package, which is this depth; going further would walk
 * trees whose size belongs to the operator rather than to this run, on every
 * run and every collection.
 */
const DEPENDENCY_SCAN_DEPTH = 3;

/**
 * Every `node_modules` within reach, as paths relative to `base`.
 *
 * A link counts. A folder whose installation lives elsewhere on disk still has
 * one, and asking only for a real directory left such a folder with nothing
 * carried into the checkout at all.
 *
 * Never descends into one: the inside of an installation is the largest tree on
 * the machine, and what this lane wants from it is its entries, not its depth.
 */
export async function dependencyDirs(base: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > DEPENDENCY_SCAN_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(join(base, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relative === '' ? entry.name : join(relative, entry.name);
      if (entry.name === DEPENDENCY_DIR) {
        if (entry.isDirectory() || entry.isSymbolicLink()) found.push(child);
        continue;
      }
      if (entry.name === '.git' || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      await walk(child, depth + 1);
    }
  };
  await walk('', 1);
  return found;
}

/**
 * The installations of the repository at `top` that a checkout of its folder at
 * `prefix` carries, as paths from the top level: the union of every one the
 * scan from the top level reaches and every one on the walk from the folder up
 * to the top level, the folder's own included. The scan stops at
 * `DEPENDENCY_SCAN_DEPTH`; the walk does not, so a folder three directories
 * down or more still has its own installation and each above it.
 */
export async function repositoryInstallations(top: string, prefix: string): Promise<string[]> {
  const installations = new Set(await dependencyDirs(top));
  const steps = prefix === '' ? [] : prefix.split(sep);
  for (let depth = steps.length; depth >= 0; depth -= 1) {
    const relative = join(...steps.slice(0, depth), DEPENDENCY_DIR);
    if (installations.has(relative)) continue;
    const info = await lstat(join(top, relative)).catch(() => undefined);
    if (info?.isDirectory() === true || info?.isSymbolicLink() === true) {
      installations.add(relative);
    }
  }
  return [...installations];
}

interface MirrorContext {
  /**
   * The repository's top level, resolved, so containment is decided on real
   * paths: a workspace link from a connected package may lead to a sibling
   * package, which the clone carries as much as the folder itself.
   */
  readonly rootReal: string;
  /** The clone's top level, where a path inside the repository lands. */
  readonly worktreePath: string;
}

/**
 * Where one entry of the operator's installation should point from inside the
 * checkout.
 *
 * A workspace package manager puts links in `node_modules` that lead back into
 * the repository — `@scope/pkg -> ../../packages/pkg`. Reached through a link
 * to the operator's installation, every one of those resolves into the folder
 * the operator is editing, so a harness typechecking the checkout read source
 * that was never committed and the promise that a run sees committed work only
 * was false on any workspace.
 *
 * So an entry that resolves to a path the repository itself carries — under
 * its root and outside any installation — is a workspace package. Its link is
 * computed from that real path, relative from the mirrored entry to the same
 * path in the checkout, so from wherever the checkout is reached it resolves
 * to the committed version. An entry that resolves anywhere else —
 * a real dependency, or a link landing within an installation — is pointed at
 * the operator's, which is the tree this lane will not duplicate.
 */
async function mirrorTarget(
  entryPath: string,
  mirroredPath: string,
  context: MirrorContext,
): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(entryPath);
  } catch {
    return entryPath;
  }
  if (!resolved.startsWith(context.rootReal + sep)) return entryPath;
  const inside = resolved.slice(context.rootReal.length + 1);
  if (inside.split(sep).includes(DEPENDENCY_DIR)) return entryPath;
  return relativePath(dirname(mirroredPath), join(context.worktreePath, inside));
}

/**
 * Recreate an installation's surface in the checkout, one link per entry.
 *
 * The directory is real and its entries are links: nothing is copied, and a
 * scope is opened one level further because `@scope` names a shelf of packages
 * rather than a package.
 *
 * Best effort per entry. A checkout missing one is still a checkout.
 */
async function mirrorInstallation(
  source: string,
  destination: string,
  context: MirrorContext,
  expandScopes: boolean,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch {
    return;
  }
  try {
    await mkdir(destination, { recursive: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (expandScopes && entry.name.startsWith('@')) {
      await mirrorInstallation(from, to, context, false);
      continue;
    }
    await symlink(await mirrorTarget(from, to, context), to).catch(() => {});
  }
}

/**
 * Point the checkout at the operator's installed dependencies.
 *
 * Links rather than copies: an installation is gigabytes and is identical to
 * the one already on disk. What they reach is readable and not writable — the
 * sandbox grants writes to the worktree by path, and a write through a link
 * lands on the folder's own directory, which the harness's policy withholds. So
 * a harness can run the tests and cannot corrupt what the operator installed.
 *
 * Every installation `repositoryInstallations` names is linked, at the same
 * place in the clone, whichever folder of the repository is connected and
 * however deep it lies: the folder's own and each on its way up to the top
 * level, since resolution walks up from the folder into the top level's
 * installation, where a workspace hoists most of what a package needs; and
 * every other the scan from the top level reaches, since a workspace link leads
 * into a sibling package, whose own installation holds what was not hoisted.
 */
export async function linkDependencies(top: string, checkout: Checkout): Promise<void> {
  let rootReal: string;
  try {
    rootReal = await realpath(top);
  } catch {
    rootReal = top;
  }
  const context: MirrorContext = { rootReal, worktreePath: checkout.path };
  const prefix = relativePath(checkout.path, checkout.workDir);
  for (const relative of await repositoryInstallations(top, prefix)) {
    const destination = join(checkout.path, relative);
    try {
      // Only where the checkout has the same place to put it, and has nothing
      // there already — a tracked directory of that name is the repository's.
      if (!(await lstat(dirname(destination))).isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      await lstat(destination);
      continue;
    } catch {
      // Absent, which is the case this fills.
    }
    await mirrorInstallation(join(top, relative), destination, context, true);
  }
}

/**
 * Take a mirrored installation away without following any part of it.
 *
 * Every removal acts on the link itself, and a directory goes only if emptying
 * it left it empty. That is the property the whole arrangement rests on: a
 * removal that reached through a link would take the operator's installed
 * dependencies, or the repository's own package, with the checkout.
 */
async function removeMirror(directory: string): Promise<void> {
  let info;
  try {
    info = await lstat(directory);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) {
    await unlink(directory).catch(() => {});
    return;
  }
  if (!info.isDirectory()) return;

  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      await unlink(child).catch(() => {});
      continue;
    }
    // A real directory here is a mirrored scope, whose entries are links.
    if (!entry.isDirectory()) continue;
    const scope = await readdir(child, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const inner of scope) {
      if (inner.isSymbolicLink()) await unlink(join(child, inner.name)).catch(() => {});
    }
    await rmdir(child).catch(() => {});
  }
  await rmdir(directory).catch(() => {});
}

/** Whether `path` is itself a directory, never one a link leads to. */
export async function isRealDirectory(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined))?.isDirectory() === true;
}

/**
 * Take the mirrors out of the checkout at `worktreePath`, and out of nothing
 * else: a checkout path that is a link is not walked, since what it leads to is
 * someone's real `node_modules` and its links are their installation.
 */
export async function unlinkDependencies(worktreePath: string): Promise<void> {
  if (!(await isRealDirectory(worktreePath))) return;
  for (const relative of await dependencyDirs(worktreePath)) {
    await removeMirror(join(worktreePath, relative));
  }
}
