/**
 * Contract: the executor keeps a check's builds after the check has exited,
 * under keys it reads from the commit and the machine, and hands one to a
 * later checkout only as a copy whose every file hashes as it did when kept —
 * a tampered entry is removed, not used. A file the check pointed elsewhere
 * through a link is never read into the cache.
 *
 * Keys are read from a real repository, as the executor reads them.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildKey,
  buildTooling,
  CHECK_BUILD_CACHE_MAX_AGE_MS,
  type CheckBuild,
  keepCheckBuilds,
  pruneCheckBuilds,
  restoreKeptBuilds,
  treesFromListing,
} from '../checkBuildCache.js';

const run = promisify(execFile);

/** `packages/a` is built after `packages/base`; the app after `packages/a`. */
const GRAPH: readonly CheckBuild[] = [
  { dir: 'packages/base', after: [] },
  { dir: 'packages/a', after: ['packages/base'] },
  { dir: 'apps/app', after: ['packages/a'] },
];
const BUILT_A: CheckBuild = { ...GRAPH[1]!, files: ['dist/index.js', 'dist/index.d.ts'] };

let dir: string;
let repo: string;
let tooling: string;
let first: string;
let appOnly: string;
let aChanged: string;
let baseChanged: string;
let rootChanged: string;

async function git(...args: string[]): Promise<string> {
  return (await run('git', ['-C', repo, ...args])).stdout;
}

async function put(base: string, file: string, text: string): Promise<void> {
  await mkdir(dirname(join(base, file)), { recursive: true });
  await writeFile(join(base, file), text);
}

async function commit(message: string): Promise<string> {
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
  return (await git('rev-parse', 'HEAD')).trim();
}

async function keysAt(sha: string, withTooling = tooling): Promise<Map<string, string>> {
  const rootFiles = (await git('ls-tree', '-z', sha))
    .split('\0')
    .filter((entry) => entry.includes(' blob '))
    .join('\0');
  const trees = treesFromListing(
    await git('ls-tree', '-d', '-z', sha, '--', ...GRAPH.map((build) => build.dir)),
  );
  const graph = new Map(GRAPH.map((build) => [build.dir, build.after]));
  const keys = new Map<string, string>();
  for (const build of GRAPH) {
    const key = buildKey(build.dir, graph, { rootFiles, tooling: withTooling, trees });
    if (key !== undefined) keys.set(build.dir, key);
  }
  return keys;
}

/** A checkout the check built `packages/a` in, as it leaves it. */
async function builtCheckout(name: string, output = 'export const a = 1;\n'): Promise<string> {
  const checkout = join(dir, name);
  await put(checkout, 'packages/a/src/index.ts', 'export const a = 1;\n');
  await put(checkout, 'packages/a/dist/index.js', output);
  await put(checkout, 'packages/a/dist/index.d.ts', 'export declare const a = 1;\n');
  return checkout;
}

async function freshCheckout(name: string): Promise<string> {
  const checkout = join(dir, name);
  await put(checkout, 'packages/a/src/index.ts', 'export const a = 1;\n');
  return checkout;
}

function cacheAt(name: string): string {
  return join(dir, 'host', name);
}

async function entryFiles(cacheDir: string): Promise<string[]> {
  return await readdir(join(cacheDir, 'entries')).catch(() => []);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'check-build-cache-'));
  repo = join(dir, 'repo');
  await run('git', ['init', '-q', '-b', 'main', repo]);
  await git('config', 'user.email', 't@e.com');
  await git('config', 'user.name', 'T');
  await put(repo, 'package.json', '{"private":true}\n');
  await put(repo, 'packages/base/src/index.ts', 'export const base = 1;\n');
  await put(repo, 'packages/a/src/index.ts', 'export const a = 1;\n');
  await put(repo, 'apps/app/src/main.ts', 'export const app = 1;\n');
  await put(repo, '.gitignore', 'node_modules\n');
  first = await commit('first');
  await put(repo, 'apps/app/src/main.ts', 'export const app = 2;\n');
  appOnly = await commit('the app alone');
  await put(repo, 'packages/a/src/index.ts', 'export const a = 2;\n');
  aChanged = await commit('the package');
  await put(repo, 'packages/base/src/index.ts', 'export const base = 2;\n');
  baseChanged = await commit('the package it is built after');
  await put(repo, 'package.json', '{"private":true,"type":"module"}\n');
  rootChanged = await commit('a root file');
  await put(repo, 'node_modules/.yarn-state.yml', '# installed\n');
  const found = await buildTooling(repo, 'node', repo, dirname(process.execPath));
  if (found === undefined) throw new Error('the fixture’s tooling was not found');
  tooling = found;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a build’s key', () => {
  it('is the same at a commit that left the package and what it is built after alone', async () => {
    const before = await keysAt(first);
    const after = await keysAt(appOnly);
    expect(after.get('packages/a')).toBe(before.get('packages/a'));
    expect(after.get('packages/base')).toBe(before.get('packages/base'));
    expect(after.get('apps/app')).not.toBe(before.get('apps/app'));
  });

  it('moves with the package, with a package it is built after, and with the root files', async () => {
    const at = async (sha: string): Promise<string | undefined> =>
      (await keysAt(sha)).get('packages/a');
    expect(await at(aChanged)).not.toBe(await at(appOnly));
    expect(await at(baseChanged)).not.toBe(await at(aChanged));
    expect(await at(rootChanged)).not.toBe(await at(baseChanged));
  });

  it('moves with the build tooling', async () => {
    const other = await keysAt(first, 'another installation');
    expect(other.get('packages/a')).not.toBe((await keysAt(first)).get('packages/a'));
  });

  it('is absent where the commit holds no tree for a package it is built after', () => {
    const graph = new Map(GRAPH.map((build) => [build.dir, build.after]));
    const trees = new Map([['packages/a', 'a'.repeat(40)]]);
    expect(buildKey('packages/a', graph, { rootFiles: '', tooling, trees })).toBeUndefined();
  });

  it('has no tooling where the folder’s installation records no state, so nothing is kept', async () => {
    const bare = join(dir, 'no-installation');
    await mkdir(bare, { recursive: true });
    expect(await buildTooling(bare, 'node', bare, dirname(process.execPath))).toBeUndefined();
  });
});

describe('a check’s build, kept by the executor', () => {
  it('is copied, not linked, into a later checkout at a commit reproducing its key', async () => {
    const cacheDir = cacheAt('round-trip');
    const built = await builtCheckout('built-1');
    const kept = await keepCheckBuilds({
      cacheDir,
      root: repo,
      sha: first,
      checkout: built,
      tooling,
      builds: [GRAPH[0]!, BUILT_A],
    });
    expect(kept).toEqual(['packages/a']);
    const [key] = await entryFiles(cacheDir);
    expect(key).toBe((await keysAt(first)).get('packages/a'));
    expect(await readFile(join(cacheDir, 'digests', key!), 'utf8')).toMatch(/^[0-9a-f]{64}$/);

    const fresh = await freshCheckout('fresh-1');
    const restored = await restoreKeptBuilds({
      cacheDir,
      root: repo,
      sha: appOnly,
      checkout: fresh,
      tooling,
    });
    expect(restored).toEqual([
      {
        dir: 'packages/a',
        graph: [
          ['packages/a', ['packages/base']],
          ['packages/base', []],
        ],
        files: ['dist/index.d.ts', 'dist/index.js'],
      },
    ]);
    const landed = join(fresh, 'packages', 'a', 'dist', 'index.js');
    expect(await readFile(landed, 'utf8')).toBe('export const a = 1;\n');
    const keptCopy = join(cacheDir, 'entries', key!, 'files', 'dist', 'index.js');
    expect((await stat(landed)).ino).not.toBe((await stat(keptCopy)).ino);
  });

  it('is not handed to a checkout at a commit that changed the package', async () => {
    const cacheDir = cacheAt('changed');
    await keepCheckBuilds({
      cacheDir,
      root: repo,
      sha: first,
      checkout: await builtCheckout('built-2'),
      tooling,
      builds: [GRAPH[0]!, BUILT_A],
    });
    const fresh = await freshCheckout('fresh-2');
    expect(
      await restoreKeptBuilds({ cacheDir, root: repo, sha: aChanged, checkout: fresh, tooling }),
    ).toEqual([]);
    expect(existsSync(join(fresh, 'packages', 'a', 'dist'))).toBe(false);
  });

  it('is removed, and nothing of it handed on, where a kept file was changed', async () => {
    const cacheDir = cacheAt('tampered-file');
    await keepCheckBuilds({
      cacheDir,
      root: repo,
      sha: first,
      checkout: await builtCheckout('built-3'),
      tooling,
      builds: [GRAPH[0]!, BUILT_A],
    });
    const [key] = await entryFiles(cacheDir);
    const keptFile = join(cacheDir, 'entries', key!, 'files', 'dist', 'index.js');
    await chmod(keptFile, 0o644);
    await writeFile(keptFile, 'export const a = "planted";\n');

    const fresh = await freshCheckout('fresh-3');
    expect(
      await restoreKeptBuilds({ cacheDir, root: repo, sha: first, checkout: fresh, tooling }),
    ).toEqual([]);
    expect(existsSync(join(fresh, 'packages', 'a', 'dist', 'index.js'))).toBe(false);
    expect(existsSync(join(fresh, 'packages', 'a', 'dist', 'index.d.ts'))).toBe(false);
    expect(await entryFiles(cacheDir)).toEqual([]);
    expect(existsSync(join(cacheDir, 'digests', key!))).toBe(false);
  });

  it('is removed where its manifest no longer matches the digest recorded for it', async () => {
    const cacheDir = cacheAt('tampered-manifest');
    await keepCheckBuilds({
      cacheDir,
      root: repo,
      sha: first,
      checkout: await builtCheckout('built-4'),
      tooling,
      builds: [GRAPH[0]!, BUILT_A],
    });
    const [key] = await entryFiles(cacheDir);
    const manifestPath = join(cacheDir, 'entries', key!, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: { path: string; sha256: string }[];
    };
    await put(join(cacheDir, 'entries', key!, 'files'), 'dist/extra.js', 'planted\n');
    manifest.files.push({ path: 'dist/extra.js', sha256: 'f'.repeat(64) });
    await writeFile(manifestPath, JSON.stringify(manifest));

    const fresh = await freshCheckout('fresh-4');
    expect(
      await restoreKeptBuilds({ cacheDir, root: repo, sha: first, checkout: fresh, tooling }),
    ).toEqual([]);
    expect(existsSync(join(fresh, 'packages', 'a', 'dist'))).toBe(false);
    expect(await entryFiles(cacheDir)).toEqual([]);
  });

  it('is not kept where a file it names is a link the check planted, or lies through one', async () => {
    const secret = join(dir, 'outside-the-checkout.txt');
    await writeFile(secret, 'the operator’s\n');

    const linkedFile = await builtCheckout('built-link');
    await rm(join(linkedFile, 'packages', 'a', 'dist', 'index.js'));
    await symlink(secret, join(linkedFile, 'packages', 'a', 'dist', 'index.js'));
    const linkedDir = join(dir, 'built-linked-dir');
    await put(linkedDir, 'packages/a/src/index.ts', 'export const a = 1;\n');
    await mkdir(join(dir, 'elsewhere'), { recursive: true });
    await put(join(dir, 'elsewhere'), 'index.js', 'not the build\n');
    await put(join(dir, 'elsewhere'), 'index.d.ts', 'not the build\n');
    await symlink(join(dir, 'elsewhere'), join(linkedDir, 'packages', 'a', 'dist'));

    for (const [index, checkout] of [linkedFile, linkedDir].entries()) {
      const cacheDir = cacheAt(`links-${String(index)}`);
      expect(
        await keepCheckBuilds({
          cacheDir,
          root: repo,
          sha: first,
          checkout,
          tooling,
          builds: [GRAPH[0]!, BUILT_A],
        }),
      ).toEqual([]);
      expect(await entryFiles(cacheDir)).toEqual([]);
    }
  });

  it('holds neither the files the commit tracks nor an installation', async () => {
    const cacheDir = cacheAt('tracked');
    const built = await builtCheckout('built-5');
    await put(built, 'packages/a/node_modules/.bin/tool', 'installed\n');
    await keepCheckBuilds({
      cacheDir,
      root: repo,
      sha: first,
      checkout: built,
      tooling,
      builds: [
        GRAPH[0]!,
        { ...BUILT_A, files: [...BUILT_A.files!, 'src/index.ts', 'node_modules/.bin/tool'] },
      ],
    });
    const [key] = await entryFiles(cacheDir);
    const manifest = JSON.parse(
      await readFile(join(cacheDir, 'entries', key!, 'manifest.json'), 'utf8'),
    ) as { files: { path: string }[] };
    expect(manifest.files.map((file) => file.path)).toEqual(['dist/index.d.ts', 'dist/index.js']);
  });

  it('is removed once no check was handed it for the cache’s age, and kept while one is', async () => {
    const cacheDir = cacheAt('prune');
    await keepCheckBuilds({
      cacheDir,
      root: repo,
      sha: first,
      checkout: await builtCheckout('built-6'),
      tooling,
      builds: [GRAPH[0]!, BUILT_A],
    });
    await keepCheckBuilds({
      cacheDir,
      root: repo,
      sha: aChanged,
      checkout: await builtCheckout('built-7', 'export const a = 2;\n'),
      tooling,
      builds: [GRAPH[0]!, BUILT_A],
    });
    const [handed, unused] = [
      (await keysAt(first)).get('packages/a')!,
      (await keysAt(aChanged)).get('packages/a')!,
    ];
    const now = Date.now();
    const longAgo = new Date(now - CHECK_BUILD_CACHE_MAX_AGE_MS - 1);
    for (const key of [handed, unused]) {
      await utimes(join(cacheDir, 'entries', key), longAgo, longAgo);
    }
    await restoreKeptBuilds({
      cacheDir,
      root: repo,
      sha: first,
      checkout: await freshCheckout('fresh-6'),
      tooling,
      now: new Date(now),
    });
    expect(await pruneCheckBuilds(cacheDir, CHECK_BUILD_CACHE_MAX_AGE_MS, now)).toBe(1);
    expect(await entryFiles(cacheDir)).toEqual([handed]);
    expect(existsSync(join(cacheDir, 'digests', unused))).toBe(false);
  });
});
