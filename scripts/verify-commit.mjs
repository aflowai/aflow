#!/usr/bin/env node
/**
 * This repository's checks on one commit, as a publication runs them before
 * it pushes: the folder `hb_aflow` declares `node scripts/verify-commit.mjs`.
 *
 * What changed is read from `AFLOW_CHECK_BASE...AFLOW_CHECK_SHA` — what the
 * commit adds over the base it is measured against — and the checks are
 * scoped to it: the two CI guards over the whole tree, a build of every
 * package the touched workspaces read — their project references and imports,
 * one line per package — a type-check of each touched workspace, the touched
 * tests, ESLint (errors only) on touched sources and Prettier on every touched
 * file. One line per step, and the first failure ends the run with that step's
 * output.
 *
 * Run by hand from a checkout, it measures `HEAD` against `origin/main`.
 *
 * It runs where a check runs: a detached checkout with the folder's installed
 * dependencies linked, nothing built and egress closed. So it calls the
 * installed tools directly — Yarn, through Corepack, would fetch itself into an
 * empty home — and builds what postinstall builds after an install, since a
 * checkout holds none of it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binDir = path.join(repoRoot, 'node_modules', '.bin');

const base = process.env['AFLOW_CHECK_BASE'] ?? 'origin/main';
const sha = process.env['AFLOW_CHECK_SHA'] ?? 'HEAD';

/** What one step may print before it is cut off: a type-check of a broken workspace fits. */
const STEP_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** Suites that drop and recreate schemas in the database they are pointed at. */
const DATABASE_TEST_FILE = /\.pg\.test\.[cm]?[jt]sx?$/;
const LINTED_SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * The guards over the Store's catalog: they hold every skill and bundle to
 * what the Store installs, so any change in `platform-artifacts` answers to
 * them whether or not it touched one of their files.
 */
const CATALOG_GUARD_DIR = 'packages/platform-artifacts/src';
const CATALOG_GUARD_FILE =
  /(?:\.guard\.test\.ts|^storeCatalog\.test\.ts|^catalogSkillsInstallable\.test\.ts|^crossRegistryCatalogIds\.test\.ts)$/;

function fail(label, startedAt, text) {
  console.log(`FAIL ${label} (${elapsed(startedAt)})`);
  if (text.trim() !== '') process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  process.exit(1);
}

function elapsed(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
}

/**
 * The environment each step runs in. The executor sets `GIT_NO_REPLACE_OBJECTS`
 * so a check reads the commits a push sends; this script honours that where it
 * reads the range, and gives its steps git's default back, because this
 * repository's own tests plant replace refs and assert that git follows them.
 */
function stepEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env['GIT_NO_REPLACE_OBJECTS'];
  return env;
}

function run(label, command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: stepEnv(options.env),
    encoding: 'utf8',
    maxBuffer: STEP_OUTPUT_LIMIT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const printed = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error !== undefined) fail(label, startedAt, `${printed}${result.error.message}\n`);
  if (result.status !== 0) fail(label, startedAt, printed);
  console.log(`ok   ${label} (${elapsed(startedAt)})`);
}

function bin(name) {
  return path.join(binDir, name);
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    encoding: 'utf8',
    maxBuffer: STEP_OUTPUT_LIMIT_BYTES,
  });
  if (result.status !== 0) {
    console.log(`FAIL reading what changed: git ${args.join(' ')}`);
    process.stdout.write(result.stderr ?? '');
    process.exit(1);
  }
  return result.stdout;
}

/**
 * The `@aflow/*` packages a workspace's sources import, apart by reader: a
 * test reads every package it imports from that package's build, but only the
 * other sources are compiled with the workspace, so only they order its build.
 */
function importedPackages(dir) {
  const compiled = new Set();
  const tested = new Set();
  const sourceDir = path.join(repoRoot, dir, 'src');
  if (!existsSync(sourceDir)) return { compiled, tested };
  for (const file of readdirSync(sourceDir, { recursive: true })) {
    if (!LINTED_SOURCE.test(String(file))) continue;
    const found = TEST_FILE.test(String(file)) ? tested : compiled;
    const text = readFileSync(path.join(sourceDir, String(file)), 'utf8');
    for (const match of text.matchAll(/['"](@aflow\/[a-z0-9-]+)/g)) found.add(match[1]);
  }
  return { compiled, tested };
}

/** The configs a workspace is type-checked under, relative to the root. */
function typecheckedConfigs(name, dir) {
  const configs = [`${dir}/tsconfig.json`];
  if (name === '@aflow/web-product') configs.push(`${dir}/src/ui/tsconfig.json`);
  return configs.filter((config) => existsSync(path.join(repoRoot, config)));
}

/** The workspace directories a config's project `references` name. */
function referencedDirs(config) {
  const file = path.join(repoRoot, config);
  const { config: parsed, error } = ts.readConfigFile(file, ts.sys.readFile);
  if (error !== undefined) {
    console.log(`FAIL reading ${config}`);
    console.log(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
    process.exit(1);
  }
  return (parsed.references ?? []).map((reference) =>
    path
      .relative(repoRoot, path.resolve(path.dirname(file), reference.path))
      .split(path.sep)
      .slice(0, 2)
      .join('/'),
  );
}

/**
 * Every workspace, by name and by directory: what it is built after — the
 * projects its configs reference and the packages its sources import, since
 * not every import here has a reference — and everything it reads, which adds
 * what its tests import and its manifest declares.
 */
function readWorkspaces() {
  const byName = new Map();
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      const dir = `${group}/${entry.name}`;
      const manifestPath = path.join(repoRoot, dir, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      byName.set(manifest.name, {
        name: manifest.name,
        dir,
        build: manifest.scripts?.build,
        configs: typecheckedConfigs(manifest.name, dir),
        declared: Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.peerDependencies,
        }).filter((name) => name.startsWith('@aflow/')),
        imported: importedPackages(dir),
      });
    }
  }
  const byDir = new Map([...byName.values()].map((w) => [w.dir, w]));
  for (const workspace of byName.values()) {
    const referenced = workspace.configs
      .flatMap(referencedDirs)
      .map((dir) => byDir.get(dir)?.name)
      .filter((name) => name !== undefined);
    const others = (names) => [...new Set(names)].filter((name) => name !== workspace.name);
    workspace.builtAfter = others([...referenced, ...workspace.imported.compiled]);
    workspace.reads = others([
      ...workspace.builtAfter,
      ...workspace.imported.tested,
      ...workspace.declared,
    ]);
  }
  return { byName, byDir };
}

const touched = git(['diff', '--name-only', '--no-renames', '-z', `${base}...${sha}`])
  .split('\0')
  .filter((file) => file !== '');
const present = touched.filter((file) => existsSync(path.join(repoRoot, file)));
console.log(`${String(touched.length)} files changed in ${base}...${sha}`);

const workspaces = readWorkspaces();
const touchedWorkspaces = [
  ...new Set(
    touched
      .map((file) => file.split('/').slice(0, 2).join('/'))
      .filter((dir) => workspaces.byDir.has(dir)),
  ),
]
  .sort()
  .map((dir) => workspaces.byDir.get(dir));

// tsx as a loader rather than its CLI: the CLI opens a socket to talk to its
// child, and the sandbox a check runs in refuses to listen on one.
for (const guard of ['large-files', 'context-budget']) {
  run(`${guard} guard`, process.execPath, ['--import', 'tsx', `scripts/${guard}/cli.ts`, 'check'], {
    env: { NODE_OPTIONS: '--conditions=ts-source' },
  });
}

// A type-check reads every other package from its compiled declarations, and a
// test from its compiled output. `yarn install` builds both through
// postinstall; a checkout mirrors the installation and builds nothing. So
// every package the touched workspaces read is built here first, after the
// packages it is built against, by its own `build` — which writes inside its
// own directory, so in the checkout and never in the folder.
const needed = new Set();
const need = (name) => {
  const workspace = workspaces.byName.get(name);
  if (workspace === undefined || needed.has(name)) return;
  needed.add(name);
  for (const read of workspace.reads) need(read);
};
for (const workspace of touchedWorkspaces) {
  for (const read of workspace.reads) need(read);
  if (workspace.dir.startsWith('packages/')) need(workspace.name);
}
const ordered = [];
const placed = new Set();
const place = (name) => {
  if (placed.has(name) || !needed.has(name)) return;
  placed.add(name);
  for (const earlier of workspaces.byName.get(name).builtAfter) place(earlier);
  ordered.push(workspaces.byName.get(name));
};
for (const name of [...needed].sort()) place(name);
for (const workspace of ordered) {
  if (workspace.build === undefined || !workspace.dir.startsWith('packages/')) continue;
  run(`build ${workspace.name}`, 'sh', ['-c', workspace.build], {
    cwd: path.join(repoRoot, workspace.dir),
    env: {
      PATH: [
        path.join(repoRoot, workspace.dir, 'node_modules', '.bin'),
        binDir,
        process.env['PATH'],
      ]
        .filter(Boolean)
        .join(path.delimiter),
    },
  });
}

const touchedNames = new Set(touchedWorkspaces.map((w) => w.name));
for (const config of touchedWorkspaces.flatMap((workspace) => workspace.configs)) {
  run(`tsc ${config}`, bin('tsc'), ['-p', config, '--noEmit']);
}

const catalogGuards = touchedNames.has('@aflow/platform-artifacts')
  ? readdirSync(path.join(repoRoot, CATALOG_GUARD_DIR), { recursive: true })
      .map((file) => `${CATALOG_GUARD_DIR}/${String(file)}`)
      .filter((file) => CATALOG_GUARD_FILE.test(path.basename(file)))
  : [];
const tests = [
  ...new Set([...present.filter((file) => TEST_FILE.test(file)), ...catalogGuards]),
].filter((file) => !DATABASE_TEST_FILE.test(file));
if (tests.length === 0) {
  console.log('ok   tests: none touched');
} else {
  // What `yarn test:file` runs.
  run(`tests (${String(tests.length)} files)`, process.execPath, [
    'scripts/test-runner.mjs',
    'file',
    ...tests.sort(),
  ]);
}

const sources = present.filter((file) => LINTED_SOURCE.test(file));
if (sources.length === 0) {
  console.log('ok   eslint: no sources touched');
} else {
  run(`eslint (${String(sources.length)} files, errors only)`, bin('eslint'), [
    '--quiet',
    '--no-warn-ignored',
    ...sources,
  ]);
}

if (present.length === 0) {
  console.log('ok   prettier: no files touched');
} else {
  run(`prettier (${String(present.length)} files)`, bin('prettier'), [
    '--check',
    '--ignore-unknown',
    ...present,
  ]);
}
