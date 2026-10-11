/**
 * Contract: a package's build is kept under the hash of what it reads, so a
 * checkout at another commit holding the same package links that build in and
 * does not run it, while a change to the package, to a package it is built
 * after or to the repository's root files keys it anew.
 *
 * Keys are read from a real repository, as the check reads them from git.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildCacheKeys,
  CHECK_BUILD_CACHE_MAX_AGE_MS,
  filesWritten,
  keepBuild,
  linkKeptBuild,
  pruneBuildCache,
  snapshotFiles,
  treesFromListing,
} from './build-cache.mjs';

const WORKSPACES = [
  { name: '@acme/base', dir: 'packages/base', builtAfter: [] },
  { name: '@acme/a', dir: 'packages/a', builtAfter: ['@acme/base'] },
  // An installed package, no workspace: the lockfile among the root files keys it.
  { name: '@acme/b', dir: 'packages/b', builtAfter: ['@acme/installed'] },
  { name: '@acme/app', dir: 'apps/app', builtAfter: ['@acme/a'] },
];
/** Owner write bits, which no kept file carries. */
const WRITABLE_BITS = 0o222;

let dir;
let repo;

function git(...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

async function put(file, text) {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), text);
}

function commit(message) {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD').trim();
}

/** The keys at `sha`, read as the check reads them. */
function keysAt(sha) {
  return buildCacheKeys({
    rootFiles: git('ls-tree', '-z', sha)
      .split('\0')
      .filter((entry) => entry.includes(' blob '))
      .join('\0'),
    trees: treesFromListing(
      git('ls-tree', '-d', '-z', sha, '--', ...WORKSPACES.map((workspace) => workspace.dir)),
    ),
    workspaces: WORKSPACES,
  });
}

let first;
let appOnly;
let baseChanged;
let rootChanged;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'build-cache-'));
  repo = path.join(dir, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'T');
  await put('package.json', '{"private":true}\n');
  await put('packages/base/src/index.ts', 'export const base = 1;\n');
  await put('packages/a/src/index.ts', 'export const a = 1;\n');
  await put('packages/b/src/index.ts', 'export const b = 1;\n');
  await put('apps/app/src/main.ts', 'export const app = 1;\n');
  first = commit('first');
  await put('apps/app/src/main.ts', 'export const app = 2;\n');
  appOnly = commit('the app alone');
  await put('packages/base/src/index.ts', 'export const base = 2;\n');
  baseChanged = commit('the package a is built after');
  await put('package.json', '{"private":true,"type":"module"}\n');
  rootChanged = commit('a root file');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a package’s key', () => {
  it('is the same at a commit that left it and everything it is built after alone', () => {
    const before = keysAt(first);
    const after = keysAt(appOnly);
    expect(after.get('@acme/a')).toBe(before.get('@acme/a'));
    expect(after.get('@acme/base')).toBe(before.get('@acme/base'));
    expect(after.get('@acme/app')).not.toBe(before.get('@acme/app'));
    expect(after.get('@acme/b')).toBe(before.get('@acme/b'));
    expect(after.get('@acme/b')).toBeDefined();
  });

  it('moves with a package it is built after, and with nothing it is not', () => {
    const before = keysAt(appOnly);
    const after = keysAt(baseChanged);
    expect(after.get('@acme/base')).not.toBe(before.get('@acme/base'));
    expect(after.get('@acme/a')).not.toBe(before.get('@acme/a'));
    expect(after.get('@acme/b')).toBe(before.get('@acme/b'));
  });

  it('moves for every package with the repository’s root files', () => {
    const before = keysAt(baseChanged);
    const after = keysAt(rootChanged);
    for (const workspace of WORKSPACES) {
      expect(after.get(workspace.name)).not.toBe(before.get(workspace.name));
    }
  });

  it('is absent for a package with no tree at the commit, and for what is built after it', () => {
    const keys = buildCacheKeys({
      rootFiles: '',
      trees: new Map([['packages/base', 'a'.repeat(40)]]),
      workspaces: WORKSPACES,
    });
    expect([...keys.keys()]).toEqual(['@acme/base']);
  });
});

describe('a build kept in the cache', () => {
  it('is linked into another checkout read-only, the build not run there', async () => {
    const cache = path.join(dir, 'cache-link');
    const built = path.join(dir, 'checkout-1', 'packages', 'a');
    const fresh = path.join(dir, 'checkout-2', 'packages', 'a');
    await put('../checkout-1/packages/a/src/index.ts', 'export const a = 1;\n');
    await put('../checkout-2/packages/a/src/index.ts', 'export const a = 1;\n');
    await mkdir(path.join(built, 'node_modules', '.bin'), { recursive: true });
    const key = keysAt(appOnly).get('@acme/a');

    expect(linkKeptBuild(cache, key, fresh)).toBe(false);
    const before = snapshotFiles(built);
    await put('../checkout-1/packages/a/dist/index.js', 'export const a = 1;\n');
    await put('../checkout-1/packages/a/dist/index.d.ts', 'export declare const a = 1;\n');
    await put('../checkout-1/packages/a/node_modules/.bin/tool', 'not a build output\n');
    const written = filesWritten(built, before);
    expect(written).toEqual(['dist/index.d.ts', 'dist/index.js']);
    expect(keepBuild(cache, key, built, written)).toBeUndefined();

    expect(linkKeptBuild(cache, key, fresh)).toBe(true);
    const linked = path.join(fresh, 'dist', 'index.js');
    expect(readFileSync(linked, 'utf8')).toBe('export const a = 1;\n');
    expect(statSync(linked).ino).toBe(
      statSync(path.join(cache, key, 'files', 'dist', 'index.js')).ino,
    );
    expect(statSync(linked).mode & WRITABLE_BITS).toBe(0);
    expect(existsSync(path.join(fresh, 'node_modules'))).toBe(false);
  });

  it('stands where another check kept the same key first', async () => {
    const cache = path.join(dir, 'cache-race');
    const packageDir = path.join(dir, 'checkout-race');
    await mkdir(path.join(packageDir, 'dist'), { recursive: true });
    await writeFile(path.join(packageDir, 'dist', 'index.js'), 'first\n');
    expect(keepBuild(cache, 'k', packageDir, ['dist/index.js'])).toBeUndefined();
    await rm(path.join(packageDir, 'dist', 'index.js'), { force: true });
    await writeFile(path.join(packageDir, 'dist', 'index.js'), 'second\n');
    expect(keepBuild(cache, 'k', packageDir, ['dist/index.js'])).toBeUndefined();
    expect(readFileSync(path.join(cache, 'k', 'files', 'dist', 'index.js'), 'utf8')).toBe(
      'first\n',
    );
  });

  it('is refused, and nothing linked, where its manifest names a path outside the package', async () => {
    const cache = path.join(dir, 'cache-escape');
    await mkdir(path.join(cache, 'k', 'files'), { recursive: true });
    await writeFile(path.join(cache, 'k', 'files.json'), JSON.stringify(['../../escaped']));
    expect(linkKeptBuild(cache, 'k', path.join(dir, 'checkout-escape', 'p'))).toBe(false);
    expect(existsSync(path.join(dir, 'escaped'))).toBe(false);
  });

  it('is removed once nobody linked it for the cache’s age, and kept while somebody does', async () => {
    const cache = path.join(dir, 'cache-prune');
    const packageDir = path.join(dir, 'checkout-prune');
    await mkdir(path.join(packageDir, 'dist'), { recursive: true });
    await writeFile(path.join(packageDir, 'dist', 'index.js'), 'kept\n');
    keepBuild(cache, 'old', packageDir, ['dist/index.js']);
    keepBuild(cache, 'used', packageDir, ['dist/index.js']);
    const now = Date.now();
    const longAgo = new Date(now - CHECK_BUILD_CACHE_MAX_AGE_MS - 1);
    await utimes(path.join(cache, 'old'), longAgo, longAgo);
    await utimes(path.join(cache, 'used'), longAgo, longAgo);
    expect(linkKeptBuild(cache, 'used', path.join(dir, 'checkout-prune-2'), new Date(now))).toBe(
      true,
    );
    expect(pruneBuildCache(cache, CHECK_BUILD_CACHE_MAX_AGE_MS, now)).toBe(1);
    expect(existsSync(path.join(cache, 'old'))).toBe(false);
    expect(existsSync(path.join(cache, 'used'))).toBe(true);
  });
});
