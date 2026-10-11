#!/usr/bin/env node
/**
 * This repository's checks on one commit, as a publication runs them before
 * it pushes: the folder `hb_aflow` declares `node scripts/verify-commit.mjs`.
 *
 * What changed is read from `AFLOW_CHECK_BASE...AFLOW_CHECK_SHA` — what the
 * commit adds over the base it is measured against — and the checks are
 * scoped to it: the two CI guards over the whole tree, a build of every
 * package the touched workspaces read — their project references and imports,
 * one line per package — a type-check of each touched workspace, the tests
 * whose imports reach a touched file or whose source names one by its path, in
 * the touched workspaces and every workspace that reads a touched package —
 * such a package built first, such an application's build named as skipped —
 * the repository-shape guards for a touched file outside every workspace and
 * the guards over every production source for a touched one, where the
 * repository has them, on half the machine's cores, each test given the time
 * `check-tests.mjs` sizes for a loaded machine unless it declares its own, on
 * macOS less the tests tagged `listener`, each named as skipped and their count
 * written where `AFLOW_CHECK_REPORT` says (`listener-tests.mjs`), ESLint
 * (errors only) on touched sources and Prettier on every touched file. Each
 * step names what it is doing as it starts and ends in one line, the tests
 * reporting only their failures and summary, and the first failure ends the
 * run with that step's output. A test run that failed only because tests ran
 * out of their time names them, and the report says which they were, so a
 * publication can run the checks once more.
 *
 * Run by hand from a checkout, it measures `HEAD` against `origin/main`.
 *
 * It runs where a check runs: a detached checkout with the folder's installed
 * dependencies linked, nothing built and egress closed. So it calls the
 * installed tools directly — Yarn, through Corepack, would fetch itself into an
 * empty home — and builds what postinstall builds after an install, since a
 * checkout holds none of it. Where `AFLOW_CHECK_BUILD_CACHE` names a
 * directory, as the executor does for every check of a folder, a package
 * unchanged since a check built it is linked from there instead
 * (`build-cache.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  buildCacheKeys,
  CHECK_BUILD_CACHE_ENV,
  CHECK_BUILD_CACHE_MAX_AGE_MS,
  filesWritten,
  keepBuild,
  linkKeptBuild,
  pruneBuildCache,
  snapshotFiles,
  treesFromListing,
} from './build-cache.mjs';
import { elapsed, failStep, runStep, STEP_OUTPUT_LIMIT_BYTES } from './check-steps.mjs';
import {
  CHECK_TEST_RESULTS_ENV,
  checkTestOptions,
  testsTimedOutAlone,
  timedOutLines,
} from './check-tests.mjs';
import {
  listenerSkipLines,
  listenersRefused,
  skippedListenerTests,
  WITHOUT_LISTENER_TESTS,
} from './listener-tests.mjs';
import {
  repositoryShapeGuards,
  testsNaming,
  testsReaching,
  treeWideGuards,
} from './test-selection.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binDir = path.join(repoRoot, 'node_modules', '.bin');

const base = process.env['AFLOW_CHECK_BASE'] ?? 'origin/main';
const sha = process.env['AFLOW_CHECK_SHA'] ?? 'HEAD';

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

/**
 * The guards over the repository's own files, which run for a touched file
 * outside every workspace. A repository without this directory has none.
 */
const REPOSITORY_SHAPE_GUARD_DIR = 'packages/schemas/src/edition';

/**
 * The guards over every production source, which run for a touched one: the
 * tests here that read the files `TREE_WALKER` lists. A repository without
 * that module has none.
 */
const TREE_GUARD_DIR = 'packages/schemas/src/__tests__';
const TREE_WALKER = `${TREE_GUARD_DIR}/backgroundWorkScanner.ts`;

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

/** Run one step, `activity` naming it as it starts; a failure ends the run unless `onFailure` says more first. */
async function run(label, activity, command, args, options = {}) {
  const step = await runStep({
    label,
    activity,
    command,
    args,
    cwd: options.cwd ?? repoRoot,
    env: stepEnv(options.env),
  });
  if (step.passed) return;
  options.onFailure?.();
  await failStep(label, step.startedAt, step.printed);
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

// A touched package's contract meets its consumers here rather than after the
// push — but only the tests that can observe the change: of every test in the
// touched workspaces and in those that read a touched package, directly or
// through another, the ones whose import closure reaches a touched file, and
// the ones naming a touched file by its path, as a test running a script does.
const touchedPackageNames = new Set(
  touchedWorkspaces.filter((w) => w.dir.startsWith('packages/')).map((w) => w.name),
);
const dependentNames = new Set();
for (let grew = true; grew;) {
  grew = false;
  for (const workspace of workspaces.byName.values()) {
    if (touchedPackageNames.has(workspace.name) || dependentNames.has(workspace.name)) continue;
    if (workspace.reads.some((name) => touchedPackageNames.has(name) || dependentNames.has(name))) {
      dependentNames.add(workspace.name);
      grew = true;
    }
  }
}
const dependentWorkspaces = [...dependentNames]
  .map((name) => workspaces.byName.get(name))
  .sort((a, b) => a.dir.localeCompare(b.dir));
const testsOf = (workspace) => {
  const sourceDir = path.join(repoRoot, workspace.dir, 'src');
  if (!existsSync(sourceDir)) return [];
  return readdirSync(sourceDir, { recursive: true })
    .map((file) => `${workspace.dir}/src/${String(file).split(path.sep).join('/')}`)
    .filter((file) => TEST_FILE.test(file) && !DATABASE_TEST_FILE.test(file));
};
const mergeBase = git(['merge-base', base, sha]).trim();
const added = new Set(
  git(['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', `${base}...${sha}`]).split(
    '\0',
  ),
);
const candidates = [...touchedWorkspaces, ...dependentWorkspaces].flatMap(testsOf);
const imported = testsReaching({
  repository: repoRoot,
  files: touched,
  candidates,
  textAtBase: (file) => (added.has(file) ? undefined : git(['show', `${mergeBase}:${file}`])),
  packageDirOf: (specifier) =>
    workspaces.byName.get(specifier.match(/^@aflow\/[a-z0-9-]+/)?.[0])?.dir,
});
const namedOnly = testsNaming({ repository: repoRoot, files: touched, candidates }).filter(
  (file) => !imported.includes(file),
);
const reaching = [...imported, ...namedOnly];
const reachingByWorkspace = Map.groupBy(reaching, (file) =>
  workspaces.byDir.get(file.split('/').slice(0, 2).join('/')),
);
const testedDependents = dependentWorkspaces.filter((w) => reachingByWorkspace.has(w));
console.log(
  `${String(reaching.length)} tests reach the touched files` +
    (reachingByWorkspace.size > 0
      ? `: ${[...reachingByWorkspace]
          .map(([workspace, files]) => `${workspace.name} ${String(files.length)}`)
          .join(', ')}`
      : '') +
    (namedOnly.length > 0 ? `; by path, importing none: ${namedOnly.join(', ')}` : ''),
);
const shapeGuardDir = path.join(repoRoot, REPOSITORY_SHAPE_GUARD_DIR);
const shapeGuards = repositoryShapeGuards({
  files: touched,
  workspaceDirs: new Set(workspaces.byDir.keys()),
  guards: existsSync(shapeGuardDir)
    ? readdirSync(shapeGuardDir)
        .map((file) => `${REPOSITORY_SHAPE_GUARD_DIR}/${file}`)
        .filter((file) => TEST_FILE.test(file))
    : [],
});
if (shapeGuards.outside.length > 0) {
  console.log(
    (shapeGuards.guards.length > 0
      ? `${String(shapeGuards.guards.length)} repository-shape guards (${REPOSITORY_SHAPE_GUARD_DIR}) run`
      : `no repository-shape guards (${REPOSITORY_SHAPE_GUARD_DIR}) in this repository to run`) +
      ` for the files outside every workspace: ${shapeGuards.outside.join(', ')}`,
  );
}
const treeGuardDir = path.join(repoRoot, TREE_GUARD_DIR);
const treeGuards = existsSync(path.join(repoRoot, TREE_WALKER))
  ? treeWideGuards({
      repository: repoRoot,
      files: touched,
      workspaceDirs: new Set(workspaces.byDir.keys()),
      walker: TREE_WALKER,
      candidates: readdirSync(treeGuardDir)
        .map((file) => `${TREE_GUARD_DIR}/${file}`)
        .filter((file) => TEST_FILE.test(file) && !DATABASE_TEST_FILE.test(file)),
    })
  : { production: [], guards: [] };
if (treeGuards.guards.length > 0) {
  console.log(
    `${String(treeGuards.guards.length)} guards over every production source run for ` +
      `${String(treeGuards.production.length)} touched: ${treeGuards.guards.join(', ')}`,
  );
}
const treeGuardWorkspace = workspaces.byDir.get(TREE_GUARD_DIR.split('/').slice(0, 2).join('/'));

// tsx as a loader rather than its CLI: the CLI opens a socket to talk to its
// child, and the sandbox a check runs in refuses to listen on one.
for (const guard of ['large-files', 'context-budget']) {
  await run(
    `${guard} guard`,
    `running the ${guard} guard`,
    process.execPath,
    ['--import', 'tsx', `scripts/${guard}/cli.ts`, 'check'],
    { env: { NODE_OPTIONS: '--conditions=ts-source' } },
  );
}

// A type-check reads every other package from its compiled declarations, and a
// test from its compiled output. `yarn install` builds both through
// postinstall; a checkout mirrors the installation and builds nothing. So
// every package the touched workspaces read is built here first, after the
// packages it is built against, by its own `build` — which writes inside its
// own directory, so in the checkout and never in the folder. A dependent about
// to be tested is built too, since its tests can read its own output as they
// read any other package's. Only packages are built, as postinstall builds
// them: an application builds in its deploy pipeline — `web-local`'s fetches
// its fonts, which a check's closed egress refuses — so its build is skipped,
// by name, and its tests run without it.
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
const guardWorkspaces = treeGuards.guards.length > 0 ? [treeGuardWorkspace] : [];
for (const workspace of [...testedDependents, ...guardWorkspaces]) {
  for (const read of workspace.reads) need(read);
  need(workspace.name);
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

// A package's build is kept under the hash of what it reads (`build-cache.mjs`),
// read from the commit as git hashes it — so the cache serves only a checkout
// at that commit, as every check is, and is left unset by hand, where the
// working tree may differ from it.
const cacheDir = process.env[CHECK_BUILD_CACHE_ENV] || undefined;
const cacheKeys =
  cacheDir === undefined
    ? new Map()
    : buildCacheKeys({
        rootFiles: git(['ls-tree', '-z', sha])
          .split('\0')
          .filter((entry) => entry.includes(' blob '))
          .join('\0'),
        trees: treesFromListing(
          git(['ls-tree', '-d', '-z', sha, '--', ...[...workspaces.byDir.keys()].sort()]),
        ),
        workspaces: [...workspaces.byName.values()],
      });
for (const workspace of ordered) {
  if (workspace.build === undefined) continue;
  if (!workspace.dir.startsWith('packages/')) {
    console.log(`skip build ${workspace.name}: an application builds in its deploy pipeline`);
    continue;
  }
  const packageDir = path.join(repoRoot, workspace.dir);
  const key = cacheKeys.get(workspace.name);
  const linkedAt = Date.now();
  if (key !== undefined && linkKeptBuild(cacheDir, key, packageDir)) {
    console.log(
      `ok   build ${workspace.name}: unchanged, linked from the build cache (${elapsed(linkedAt)})`,
    );
    continue;
  }
  const before = key === undefined ? undefined : snapshotFiles(packageDir);
  await run(
    `build ${workspace.name}`,
    `building ${workspace.name}`,
    'sh',
    ['-c', workspace.build],
    {
      cwd: packageDir,
      env: {
        PATH: [path.join(packageDir, 'node_modules', '.bin'), binDir, process.env['PATH']]
          .filter(Boolean)
          .join(path.delimiter),
      },
    },
  );
  if (before !== undefined) {
    const refusal = keepBuild(cacheDir, key, packageDir, filesWritten(packageDir, before));
    if (refusal !== undefined) {
      console.log(`note the build cache could not keep ${workspace.name}: ${refusal}`);
    }
  }
}
if (cacheDir !== undefined) pruneBuildCache(cacheDir, CHECK_BUILD_CACHE_MAX_AGE_MS);

const touchedNames = new Set(touchedWorkspaces.map((w) => w.name));
for (const config of touchedWorkspaces.flatMap((workspace) => workspace.configs)) {
  await run(`tsc ${config}`, `type-checking ${config}`, bin('tsc'), ['-p', config, '--noEmit']);
}

const catalogGuards = touchedNames.has('@aflow/platform-artifacts')
  ? readdirSync(path.join(repoRoot, CATALOG_GUARD_DIR), { recursive: true })
      .map((file) => `${CATALOG_GUARD_DIR}/${String(file)}`)
      .filter((file) => CATALOG_GUARD_FILE.test(path.basename(file)))
  : [];
const tests = [
  ...new Set([
    ...present.filter((file) => TEST_FILE.test(file)),
    ...catalogGuards,
    ...shapeGuards.guards,
    ...treeGuards.guards,
    ...reaching,
  ]),
].filter((file) => !DATABASE_TEST_FILE.test(file));
// The executor names this file to a check it runs, signs the count of skipped
// listener tests into the check's receipt, and reads the tests that ran out of
// time on a run they alone failed; run by hand, nothing names it.
const writeCheckReport = (report) => {
  const checkReport = process.env['AFLOW_CHECK_REPORT'];
  if (checkReport !== undefined && checkReport !== '') {
    writeFileSync(checkReport, JSON.stringify(report));
  }
};
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};
let skippedListeners = [];
if (tests.length === 0) {
  console.log('ok   tests: none reach the touched files');
} else {
  // What `yarn test:file` runs, reporting only the failures and the summary: a
  // sweep passes hundreds of files, and a line for each pushes the failure out
  // of what is read. Half the cores, because a check runs on the operator's
  // machine beside the stack it serves, and a test that waits on a timer fails
  // when every core is taken. Where no test can listen, the ones that must are
  // left out, and a JSON report beside the summary says which they were.
  const workers = Math.max(1, Math.floor(availableParallelism() / 2));
  const reports = mkdtempSync(path.join(tmpdir(), 'verify-commit-'));
  const testResults = path.join(reports, 'results.json');
  const jsonReport = listenersRefused() ? path.join(reports, 'tests.json') : undefined;
  await run(
    `tests (${String(tests.length)} files, ${String(workers)} workers)`,
    `running ${String(tests.length)} test files on ${String(workers)} workers`,
    process.execPath,
    [
      'scripts/test-runner.mjs',
      'file',
      ...tests.sort(),
      ...checkTestOptions(),
      ...(jsonReport === undefined
        ? []
        : [...WITHOUT_LISTENER_TESTS, '--reporter=json', `--outputFile.json=${jsonReport}`]),
    ],
    {
      env: { PHOENIX_TEST_WORKERS: String(workers), [CHECK_TEST_RESULTS_ENV]: testResults },
      onFailure: () => {
        const summary = readJson(testResults);
        const timedOut = summary === undefined ? [] : testsTimedOutAlone(summary);
        if (timedOut.length > 0) for (const line of timedOutLines(timedOut)) console.log(line);
        // A run that failed may have ended before its JSON report was written.
        const listenerReport = jsonReport === undefined ? undefined : readJson(jsonReport);
        writeCheckReport({
          skippedListenerTests:
            listenerReport === undefined
              ? 0
              : skippedListenerTests(listenerReport, repoRoot).length,
          ...(timedOut.length > 0 ? { testTimeouts: timedOut } : {}),
        });
      },
    },
  );
  if (jsonReport !== undefined) {
    skippedListeners = skippedListenerTests(JSON.parse(readFileSync(jsonReport, 'utf8')), repoRoot);
    for (const line of listenerSkipLines(skippedListeners)) console.log(line);
  }
}
writeCheckReport({ skippedListenerTests: skippedListeners.length });

const sources = present.filter((file) => LINTED_SOURCE.test(file));
if (sources.length === 0) {
  console.log('ok   eslint: no sources touched');
} else {
  await run(
    `eslint (${String(sources.length)} files, errors only)`,
    `linting ${String(sources.length)} files`,
    bin('eslint'),
    ['--quiet', '--no-warn-ignored', ...sources],
  );
}

if (present.length === 0) {
  console.log('ok   prettier: no files touched');
} else {
  await run(
    `prettier (${String(present.length)} files)`,
    `checking the format of ${String(present.length)} files`,
    bin('prettier'),
    ['--check', '--ignore-unknown', ...present],
  );
}
