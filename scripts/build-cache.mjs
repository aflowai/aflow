/**
 * The check's build cache, kept across checkouts.
 *
 * A check runs in a fresh checkout that holds no build, and builds every
 * package the touched workspaces read — about twenty for an orchestrator
 * change, nearly all of them unchanged since the last check. So a package's
 * build is kept under the hash of everything it reads: its own files at the
 * commit (the tree git already hashes), the repository's root files — the
 * lockfile and the configs every build extends — and the same hash of each
 * package it is built after. A checkout whose package hashes the same links
 * that build in rather than running it again.
 *
 * Each kept file is read-only and hard-linked into the checkout, so a writer
 * that reached one through the checkout would fail rather than change the
 * cache under every later check; where the two lie on different filesystems
 * — a sandbox that mounts them apart — the file is copied instead.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Names the directory the cache is kept in. Unset, nothing is cached. */
export const CHECK_BUILD_CACHE_ENV = 'AFLOW_CHECK_BUILD_CACHE';

/** How long a build nobody linked stays in the cache. */
export const CHECK_BUILD_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A build's files as they are kept: readable by anyone, writable by no one. */
const READ_ONLY_MODE = 0o444;
const MANIFEST_FILE = 'files.json';
const FILES_DIR = 'files';
const INCOMING_PREFIX = '.incoming-';
/** Installations a build reads and never writes. */
const NOT_BUILD_OUTPUT = 'node_modules';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Each package's key at `sha`, by name: `trees` maps a workspace directory to
 * its tree's id at the commit, `rootFiles` is git's listing of the commit's
 * root files, and `workspaces` every workspace with what it is built after. A
 * package with no tree, or built after one without a key, has none and is
 * built every time. A name it is built after that is no workspace is an
 * installed package, which the root files' lockfile already keys.
 */
export function buildCacheKeys({ rootFiles, trees, workspaces }) {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const root = sha256(rootFiles);
  const keys = new Map();
  const visiting = new Set();
  const keyOf = (name) => {
    if (keys.has(name)) return keys.get(name);
    const workspace = byName.get(name);
    const tree = workspace === undefined ? undefined : trees.get(workspace.dir);
    if (tree === undefined || visiting.has(name)) return undefined;
    visiting.add(name);
    const earlierWorkspaces = workspace.builtAfter.filter((earlier) => byName.has(earlier));
    const after = [];
    for (const earlier of [...earlierWorkspaces].sort()) {
      const key = keyOf(earlier);
      if (key === undefined) break;
      after.push(`${earlier} ${key}`);
    }
    visiting.delete(name);
    const key =
      after.length === earlierWorkspaces.length
        ? sha256([root, `${name} ${tree}`, ...after].join('\n'))
        : undefined;
    keys.set(name, key);
    return key;
  };
  for (const workspace of workspaces) keyOf(workspace.name);
  return new Map([...keys].filter(([, key]) => key !== undefined));
}

/** The tree ids `git ls-tree -z <sha> -- <dirs>` lists, by directory. */
export function treesFromListing(listing) {
  const trees = new Map();
  for (const entry of listing.split('\0')) {
    const match = /^\d+ tree ([0-9a-f]+)\t(.+)$/.exec(entry);
    if (match !== null) trees.set(match[2], match[1]);
  }
  return trees;
}

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

/** A manifest's entry, refused where it would reach outside the package. */
function keptPath(file) {
  if (typeof file !== 'string' || path.isAbsolute(file) || file.split('/').includes('..')) {
    throw new Error(`the cache names ${JSON.stringify(file)}, which is not a path in a package`);
  }
  return file;
}

function linkOrCopy(from, to) {
  try {
    linkSync(from, to);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    copyFileSync(from, to, constants.COPYFILE_FICLONE);
  }
}

/**
 * Link the build kept under `key` into `packageDir`. False where there is
 * none, or it could not be linked whole — what was linked is then removed, so
 * the build runs on a package holding none of it.
 */
export function linkKeptBuild(cacheDir, key, packageDir, now = new Date()) {
  const entry = path.join(cacheDir, key);
  let files;
  try {
    files = JSON.parse(readFileSync(path.join(entry, MANIFEST_FILE), 'utf8')).map(keptPath);
  } catch {
    return false;
  }
  const linked = [];
  try {
    for (const file of files) {
      const target = path.join(packageDir, file);
      mkdirSync(path.dirname(target), { recursive: true });
      rmSync(target, { force: true });
      linkOrCopy(path.join(entry, FILES_DIR, file), target);
      linked.push(target);
    }
    utimesSync(entry, now, now);
    return true;
  } catch {
    for (const target of linked) rmSync(target, { force: true });
    return false;
  }
}

/**
 * Keep the `files` a build wrote under `packageDir` as `key`'s. Gathered
 * apart and moved into place whole, so a check reading the cache meanwhile
 * finds the entry complete or absent; where another check kept the same key
 * first, its entry stands. Returns why it could not, or nothing.
 */
export function keepBuild(cacheDir, key, packageDir, files) {
  let incoming;
  try {
    mkdirSync(cacheDir, { recursive: true });
    incoming = mkdtempSync(path.join(cacheDir, INCOMING_PREFIX));
    for (const file of files) {
      const kept = path.join(incoming, FILES_DIR, keptPath(file));
      mkdirSync(path.dirname(kept), { recursive: true });
      copyFileSync(path.join(packageDir, file), kept, constants.COPYFILE_FICLONE);
      chmodSync(kept, READ_ONLY_MODE);
    }
    writeFileSync(path.join(incoming, MANIFEST_FILE), JSON.stringify(files));
    renameSync(incoming, path.join(cacheDir, key));
    return undefined;
  } catch (error) {
    if (incoming !== undefined) rmSync(incoming, { recursive: true, force: true });
    if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return undefined;
    return error instanceof Error ? error.message : String(error);
  }
}

/** Remove what nobody linked for `maxAgeMs`; returns how many entries went. */
export function pruneBuildCache(cacheDir, maxAgeMs, now = Date.now()) {
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const entry = path.join(cacheDir, name);
    try {
      if (now - statSync(entry).mtimeMs <= maxAgeMs) continue;
      rmSync(entry, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Another check removed it first.
    }
  }
  return removed;
}
