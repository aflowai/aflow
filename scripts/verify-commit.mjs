#!/usr/bin/env node
/**
 * This repository's checks on one commit, as a publication runs them before
 * it pushes: the folder `hb_aflow` declares `node scripts/verify-commit.mjs`.
 *
 * What changed is read from `AFLOW_CHECK_BASE...AFLOW_CHECK_SHA` — what the
 * commit adds over the base it is measured against — and the checks are
 * scoped to it: the two CI guards over the whole tree, the builds the touched
 * workspaces read, a type-check of each, the touched tests, ESLint (errors
 * only) on touched sources and Prettier on every touched file. One line per
 * step, and the first failure ends the run with that step's output.
 *
 * Run by hand from a checkout, it measures `HEAD` against `origin/main`.
 *
 * It runs where a check runs: a detached checkout with the folder's installed
 * dependencies linked and egress closed. So it calls the installed tools
 * directly — Yarn, through Corepack, would fetch itself into an empty home —
 * and builds what a type-check or a test reads from `dist`, since a fresh
 * checkout holds none.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
const CATALOG_GUARD_FILE = /(?:\.guard\.test\.ts|^storeCatalog\.test\.ts|^catalogSkillsInstallable\.test\.ts|^crossRegistryCatalogIds\.test\.ts)$/;

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
 * The `@aflow/*` packages a workspace's sources import. Read from the sources
 * as well as the manifest, because a test importing a package its manifest
 * never declared still needs that package built.
 */
function importedPackages(dir) {
  const found = new Set();
  const sourceDir = path.join(repoRoot, dir, 'src');
  if (!existsSync(sourceDir)) return found;
  for (const file of readdirSync(sourceDir, { recursive: true })) {
    if (!LINTED_SOURCE.test(String(file))) continue;
    const text = readFileSync(path.join(sourceDir, String(file)), 'utf8');
    for (const match of text.matchAll(/['"](@aflow\/[a-z0-9-]+)/g)) found.add(match[1]);
  }
  return found;
}

/** Every workspace, by directory, with the workspaces it reads. */
function readWorkspaces() {
  const byName = new Map();
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      const dir = `${group}/${entry.name}`;
      const manifestPath = path.join(repoRoot, dir, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const declared = Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      }).filter((name) => name.startsWith('@aflow/'));
      const reads = [...new Set([...declared, ...importedPackages(dir)])].filter(
        (name) => name !== manifest.name,
      );
      byName.set(manifest.name, { name: manifest.name, dir, reads, build: manifest.scripts?.build });
    }
  }
  const byDir = new Map([...byName.values()].map((w) => [w.dir, w]));
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
  run(
    `${guard} guard`,
    process.execPath,
    ['--import', 'tsx', `scripts/${guard}/cli.ts`, 'check'],
    { env: { NODE_OPTIONS: '--conditions=ts-source' } },
  );
}

// A type-check and a test read every `@aflow/*` package they import from its
// `dist`. So the packages the touched workspaces read are built — those whose
// `dist` is missing, and those touched along with everything built on them.
const touchedNames = new Set(touchedWorkspaces.map((w) => w.name));
const needed = new Set();
const visit = (name) => {
  const workspace = workspaces.byName.get(name);
  if (workspace === undefined || needed.has(name)) return;
  needed.add(name);
  for (const read of workspace.reads) visit(read);
};
for (const workspace of touchedWorkspaces) {
  for (const read of workspace.reads) visit(read);
  if (workspace.dir.startsWith('packages/')) visit(workspace.name);
}
const builtOnTouched = (name, seen = new Set()) => {
  if (touchedNames.has(name)) return true;
  if (seen.has(name)) return false;
  seen.add(name);
  return (workspaces.byName.get(name)?.reads ?? []).some((read) => builtOnTouched(read, seen));
};
const ordered = [];
const placed = new Set();
const place = (name) => {
  if (placed.has(name) || !needed.has(name)) return;
  placed.add(name);
  for (const read of workspaces.byName.get(name).reads) place(read);
  ordered.push(workspaces.byName.get(name));
};
for (const name of [...needed].sort()) place(name);
for (const workspace of ordered) {
  if (workspace.build === undefined || !workspace.dir.startsWith('packages/')) continue;
  const hasDist = existsSync(path.join(repoRoot, workspace.dir, 'dist'));
  if (hasDist && !builtOnTouched(workspace.name)) continue;
  run(`build ${workspace.name}`, 'sh', ['-c', workspace.build], {
    cwd: path.join(repoRoot, workspace.dir),
    env: {
      PATH: [path.join(repoRoot, workspace.dir, 'node_modules', '.bin'), binDir, process.env['PATH']]
        .filter(Boolean)
        .join(path.delimiter),
    },
  });
}

for (const workspace of touchedWorkspaces) {
  const configs = [`${workspace.dir}/tsconfig.json`];
  if (workspace.name === '@aflow/web-product') configs.push(`${workspace.dir}/src/ui/tsconfig.json`);
  for (const config of configs) {
    if (!existsSync(path.join(repoRoot, config))) continue;
    run(`tsc ${config}`, bin('tsc'), ['-p', config, '--noEmit']);
  }
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
