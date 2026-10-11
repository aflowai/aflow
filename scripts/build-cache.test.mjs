/**
 * Contract: the check takes a build the executor handed it only where the
 * graph the build was keyed over is the one this commit reads, and reports
 * what each build it ran wrote.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  filesWritten,
  readKeptBuilds,
  removeKeptBuild,
  sameGraph,
  snapshotFiles,
} from './build-cache.mjs';

/** The graph this commit reads: `a` is built after `base`, the app after `a`. */
const AFTER = new Map([
  ['packages/base', []],
  ['packages/a', ['packages/base']],
  ['apps/app', ['packages/a']],
]);
const afterOf = (dir) => AFTER.get(dir);

let dir;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'build-cache-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a build the executor handed the check', () => {
  it('is taken where it was keyed over the graph this commit reads', () => {
    const graph = [
      ['packages/a', ['packages/base']],
      ['packages/base', []],
    ];
    expect(sameGraph(graph, 'packages/a', afterOf)).toBe(true);
    expect(sameGraph([['packages/base', []]], 'packages/base', afterOf)).toBe(true);
  });

  it('is refused where the reporting check named other packages, fewer or more', () => {
    expect(sameGraph([['packages/a', []]], 'packages/a', afterOf)).toBe(false);
    expect(
      sameGraph(
        [
          ['packages/a', ['packages/base', 'packages/other']],
          ['packages/base', []],
          ['packages/other', []],
        ],
        'packages/a',
        afterOf,
      ),
    ).toBe(false);
    expect(
      sameGraph(
        [
          ['packages/a', ['packages/base']],
          ['packages/base', []],
          ['packages/unrelated', []],
        ],
        'packages/a',
        afterOf,
      ),
    ).toBe(false);
    expect(sameGraph([['packages/gone', []]], 'packages/gone', afterOf)).toBe(false);
  });

  it('is read from the list the executor names, and none is read where it names none', async () => {
    const list = path.join(dir, 'kept.json');
    await writeFile(
      list,
      JSON.stringify([
        { dir: 'packages/a', graph: [['packages/a', []]], files: ['dist/index.js'] },
        { dir: 'packages/broken' },
      ]),
    );
    expect([...readKeptBuilds(list).keys()]).toEqual(['packages/a']);
    expect(readKeptBuilds(undefined).size).toBe(0);
    expect(readKeptBuilds(path.join(dir, 'absent.json')).size).toBe(0);
  });

  it('is taken back out of the package before the package is built', async () => {
    const packageDir = path.join(dir, 'refused');
    await mkdir(path.join(packageDir, 'dist'), { recursive: true });
    await writeFile(path.join(packageDir, 'dist', 'index.js'), 'kept\n');
    removeKeptBuild(packageDir, ['dist/index.js']);
    expect(existsSync(path.join(packageDir, 'dist', 'index.js'))).toBe(false);
  });
});

describe('what a build wrote', () => {
  it('is every file new or changed under the package but its installation', async () => {
    const packageDir = path.join(dir, 'built');
    await mkdir(path.join(packageDir, 'src'), { recursive: true });
    await mkdir(path.join(packageDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(path.join(packageDir, 'src', 'index.ts'), 'export const a = 1;\n');
    const before = snapshotFiles(packageDir);
    await mkdir(path.join(packageDir, 'dist'));
    await writeFile(path.join(packageDir, 'dist', 'index.js'), 'export const a = 1;\n');
    await writeFile(path.join(packageDir, 'dist', 'index.d.ts'), 'export declare const a = 1;\n');
    await writeFile(path.join(packageDir, 'node_modules', '.bin', 'tool'), 'not a build output\n');
    expect(filesWritten(packageDir, before)).toEqual(['dist/index.d.ts', 'dist/index.js']);
  });
});
