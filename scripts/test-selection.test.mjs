/**
 * Contract: the check runs the tests that can observe a change, followed by
 * name through every re-export or naming a touched file by its path, and none
 * that cannot.
 */
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  repositoryShapeGuards,
  testsNaming,
  testsReaching,
  treeWideGuards,
} from './test-selection.mjs';

const INDEX = [
  'export * from "./a.js";',
  'export { b } from "./b.js";',
  'export { c } from "./c.js";',
  '',
].join('\n');

const FILES = {
  'packages/p/package.json': JSON.stringify({
    name: '@acme/p',
    exports: { '.': { 'ts-source': './src/index.ts', types: './dist/index.d.ts' } },
  }),
  'packages/p/tsconfig.json': JSON.stringify({
    compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
  }),
  'packages/p/src/index.ts': INDEX,
  'packages/p/src/a.ts': 'export const a = 1;\n',
  'packages/p/src/b.ts': 'export const b = 2;\n',
  'packages/p/src/c.ts': 'export const c = 3;\n',
  'apps/app/tsconfig.json': JSON.stringify({
    compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' },
  }),
  'apps/app/src/types.ts': 'export interface A { readonly a: number }\n',
  'apps/app/src/helper.ts': 'import { a } from "@acme/p";\n\nexport const helper = a;\n',
  'apps/app/src/takesA.test.ts': 'import { a } from "@acme/p";\n\nvoid a;\n',
  'apps/app/src/takesB.test.ts': 'import { b } from "@acme/p";\n\nvoid b;\n',
  'apps/app/src/takesAll.test.ts': 'import * as p from "@acme/p";\n\nvoid p;\n',
  'apps/app/src/dynamic.test.ts': 'void import("@acme/p");\n',
  'apps/app/src/viaHelper.test.ts': 'import { helper } from "./helper.js";\n\nvoid helper;\n',
  'apps/app/src/typeOnly.test.ts': 'import type { A } from "./types.js";\n\nexport type B = A;\n',
  'apps/app/src/usesGone.test.ts': 'import { gone } from "./gone.js";\n\nvoid gone;\n',
  'apps/app/src/runsCheck.test.ts': 'export const CHECK = ["node", "scripts/verify-commit.mjs"];\n',
  'apps/app/src/runsInShell.test.mjs':
    'export const command = `cd ${process.cwd()} && node scripts/verify-commit.mjs --quiet`;\n',
  'apps/app/src/runsOther.test.ts': 'export const OTHER = "scripts/other.mjs";\n',
  'apps/app/src/namesPart.test.ts':
    'export const PARTS = ["verify-commit", "vendor/scripts/verify-commit.mjs"];\n',
  'apps/app/src/runsCheck.test.tsx': 'export const CHECK = "scripts/verify-commit.mjs";\n',
};

const TESTS = Object.keys(FILES).filter((file) => /\.test\.(?:mjs|tsx?)$/.test(file));

let repository;

beforeAll(async () => {
  repository = await mkdtemp(path.join(tmpdir(), 'aflow-test-selection-'));
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(repository, file)), { recursive: true });
    await writeFile(path.join(repository, file), text);
  }
  await mkdir(path.join(repository, 'node_modules', '@acme'), { recursive: true });
  await symlink(
    path.join('..', '..', 'packages', 'p'),
    path.join(repository, 'node_modules', '@acme', 'p'),
  );
});

afterAll(async () => {
  await rm(repository, { recursive: true, force: true });
});

const reaching = (files, atBase = {}) =>
  testsReaching({
    repository,
    files,
    candidates: TESTS,
    textAtBase: (file) => atBase[file] ?? FILES[file],
    packageDirOf: (specifier) => (specifier.startsWith('@acme/p') ? 'packages/p' : undefined),
  }).sort();

describe('the tests a change reaches', () => {
  it('follows a name through the package index to the module that declares it', () => {
    expect(reaching(['packages/p/src/a.ts'])).toEqual([
      'apps/app/src/dynamic.test.ts',
      'apps/app/src/takesA.test.ts',
      'apps/app/src/takesAll.test.ts',
      'apps/app/src/viaHelper.test.ts',
    ]);
  });

  it('leaves out a test that takes only other names from the same index', () => {
    expect(reaching(['packages/p/src/a.ts'])).not.toContain('apps/app/src/takesB.test.ts');
  });

  it('reaches through an added export only the tests that take the whole index', () => {
    const before = INDEX.replace('export { c } from "./c.js";\n', '');
    expect(reaching(['packages/p/src/index.ts'], { 'packages/p/src/index.ts': before })).toEqual([
      'apps/app/src/dynamic.test.ts',
      'apps/app/src/takesAll.test.ts',
    ]);
  });

  it('reaches a test whose name the index now takes from somewhere else', () => {
    const before = INDEX.replace('export { b } from "./b.js";', 'export { a as b } from "./a.js";');
    expect(reaching(['packages/p/src/index.ts'], { 'packages/p/src/index.ts': before })).toContain(
      'apps/app/src/takesB.test.ts',
    );
  });

  it('reaches a test still importing a file the change deleted', () => {
    expect(reaching(['apps/app/src/gone.ts'])).toEqual(['apps/app/src/usesGone.test.ts']);
  });

  it('does not follow a type-only import, which executes nothing', () => {
    expect(reaching(['apps/app/src/types.ts'])).toEqual([]);
  });

  it('selects a touched test itself', () => {
    expect(reaching(['apps/app/src/takesB.test.ts'])).toEqual(['apps/app/src/takesB.test.ts']);
  });
});

describe('the tests naming a touched file by its path', () => {
  const naming = (files) => testsNaming({ repository, files, candidates: TESTS }).sort();

  it('selects a test naming a touched script by path, which imports nothing from it', () => {
    expect(naming(['scripts/verify-commit.mjs'])).toEqual([
      'apps/app/src/runsCheck.test.ts',
      'apps/app/src/runsInShell.test.mjs',
    ]);
  });

  it('leaves out a test naming an unrelated path', () => {
    expect(naming(['scripts/verify-commit.mjs'])).not.toContain('apps/app/src/runsOther.test.ts');
    expect(naming(['scripts/unrelated.mjs'])).toEqual([]);
  });

  it('counts a path only whole, and reads only .mjs and .ts tests', () => {
    expect(naming(['scripts/verify-commit.mjs'])).not.toContain('apps/app/src/namesPart.test.ts');
    expect(naming(['scripts/verify-commit.mjs'])).not.toContain('apps/app/src/runsCheck.test.tsx');
  });
});

describe('the repository-shape guards a change answers to', () => {
  const SHAPE_GUARDS = ['packages/schemas/src/edition/mcpRegistration.test.ts'];
  const shapeGuards = (files) =>
    repositoryShapeGuards({
      files,
      workspaceDirs: new Set(['apps/app', 'packages/p']),
      guards: SHAPE_GUARDS,
    });

  it('runs them for a root file no import reaches, naming it', () => {
    expect(shapeGuards(['.mcp.json', 'packages/p/src/a.ts'])).toEqual({
      outside: ['.mcp.json'],
      guards: SHAPE_GUARDS,
    });
  });

  it('runs them for a file under a top-level folder that is no workspace', () => {
    expect(shapeGuards(['.github/workflows/ci.yml']).guards).toEqual(SHAPE_GUARDS);
  });

  it('runs none for a change inside the workspaces alone', () => {
    expect(shapeGuards(['packages/p/src/a.ts', 'apps/app/src/helper.ts'])).toEqual({
      outside: [],
      guards: [],
    });
  });
});

describe('the guards over every production source', () => {
  const checkout = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const GUARD_DIR = 'packages/schemas/src/__tests__';
  const treeGuards = (files) =>
    treeWideGuards({
      repository: checkout,
      files,
      workspaceDirs: new Set(['apps/aflow-executor-host', 'packages/schemas']),
      walker: `${GUARD_DIR}/backgroundWorkScanner.ts`,
      candidates: readdirSync(path.join(checkout, GUARD_DIR))
        .filter((file) => file.endsWith('.test.ts'))
        .map((file) => `${GUARD_DIR}/${file}`),
    });

  it('runs the background-work guard for a touched application source no import of it reaches', () => {
    const selected = treeGuards(['apps/aflow-executor-host/src/scanReceipt.ts']);
    expect(selected.production).toEqual(['apps/aflow-executor-host/src/scanReceipt.ts']);
    expect(selected.guards).toContain(`${GUARD_DIR}/backgroundWork.test.ts`);
    expect(selected.guards).toContain(`${GUARD_DIR}/durablePayloadPersist.test.ts`);
    expect(selected.guards).not.toContain(`${GUARD_DIR}/schemas.test.ts`);
  });

  it('runs none for a test, a declaration or a file outside every workspace', () => {
    expect(
      treeGuards([
        'apps/aflow-executor-host/src/__tests__/processExec.test.ts',
        'packages/schemas/src/env.d.ts',
        'apps/aflow-executor-host/README.md',
        'scripts/verify-commit.mjs',
      ]),
    ).toEqual({ production: [], guards: [] });
  });
});
