/**
 * Build the public-core cut and see whether it stands up.
 *
 * The ownership manifest says which paths a public core repository keeps. That
 * claim is only worth something if the remainder installs, typechecks and
 * tests on its own, and the only way to know is to delete the rest and try.
 * Static guards catch a dangling import; they cannot catch a workspace whose
 * lockfile entry went with it, a Dockerfile COPY of a directory that is gone,
 * or a config that names a deleted path.
 *
 * Works on a copy. `git archive` writes a clean tree into a scratch directory,
 * so nothing here can touch the checkout it was run from — this script deletes
 * files for a living and must never be able to do it in place.
 *
 *   node scripts/core-cut.mjs --list      what the cut removes, and stop
 *   node scripts/core-cut.mjs             delete, install, typecheck
 *   node scripts/core-cut.mjs --test      also run the test suite
 *   node scripts/core-cut.mjs --build     also build every workspace and the web app
 *   node scripts/core-cut.mjs --image     also build the image and inspect what it contains
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = process.cwd();
const args = process.argv.slice(2);
const argv = new Set(args);

/** The value after a flag, for the flags that take one. */
const valueOf = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

// The manifest is TypeScript; read it through the built bundle rather than
// re-parsing it here, so this script and the guards cannot disagree.
const {
  ENV_OWNERSHIP,
  OWNERSHIP_MANIFEST,
  buildImporterIndex,
  dependenciesWithoutSurvivingImporter,
  ownerOf,
  pruneDockerfile,
  renderBackgroundWorkCatalog,
  pruneEnvExample,
  pruneScripts,
  pruneWorkspaceManifest,
  survivesCoreCut,
  workspaceOf,
} = await import(join(REPO, 'packages/schemas/dist/index.js'));
if (OWNERSHIP_MANIFEST === undefined) {
  console.error(
    '[core-cut] no manifest in the built bundle — run `yarn workspace @aflow/schemas build`',
  );
  process.exit(1);
}

// Present is not the same as current, and the bundle has to match the tree this
// cuts — which is HEAD, because the export below archives HEAD. Two ways to be
// wrong, and each of them decides what a published image contains:
//
//   - a bundle built before the source was last committed answers every question
//     confidently and wrongly, reporting files in categories they have left;
//   - an uncommitted edit plus a rebuild makes the bundle newer than anything on
//     disk while `git archive HEAD` omits the edit entirely, so the rules applied
//     and the tree they are applied to disagree.
//
// The whole `edition` directory, not the manifest alone: the bundle also supplies
// `ownerOf`, `survivesCoreCut`, the importer scan and every `prune*` transform
// from three other files, and stale transform logic removes the wrong lines just
// as silently as a stale rule classifies the wrong file. Checking the directory
// rather than a list also survives a symbol moving between those files.
//
// CI builds from a clean checkout at HEAD, which satisfies both by construction.
const EDITION_SRC = join(REPO, 'packages/schemas/src/edition');
const MANIFEST_BUNDLE = join(REPO, 'packages/schemas/dist/index.js');

const uncommitted = execFileSync('git', ['status', '--porcelain', '--', EDITION_SRC], {
  cwd: REPO,
  encoding: 'utf-8',
})
  .split('\n')
  .filter((line) => line.trim() !== '');
if (uncommitted.length > 0) {
  console.error(
    '[core-cut] the cut reads HEAD, and these are not committed — commit them or stash them:',
  );
  for (const line of uncommitted) console.error(`  ${line.trim()}`);
  process.exit(1);
}

const bundleBuiltAt = statSync(MANIFEST_BUNDLE).mtimeMs;
const stale = readdirSync(EDITION_SRC)
  .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
  .filter((entry) => statSync(join(EDITION_SRC, entry)).mtimeMs > bundleBuiltAt);
if (stale.length > 0) {
  console.error(
    '[core-cut] the bundle this reads predates its own source — run `yarn workspace @aflow/schemas build`',
  );
  for (const entry of stale) console.error(`  ${entry}`);
  process.exit(1);
}

const tracked = execFileSync('git', ['ls-files'], {
  cwd: REPO,
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter((line) => line.trim() !== '');

const removed = [];
const unclassified = [];
for (const file of tracked) {
  const match = ownerOf(file);
  if (match === undefined) {
    unclassified.push(file);
    continue;
  }
  if (!survivesCoreCut(match.owner)) removed.push([file, match.owner]);
}

if (unclassified.length > 0) {
  console.error(
    `[core-cut] ${unclassified.length} unclassified path(s); the cut is undefined until they are decided:`,
  );
  for (const file of unclassified.slice(0, 20)) console.error(`  ${file}`);
  process.exit(1);
}

const byOwner = new Map();
for (const [, owner] of removed) byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1);
console.log(`[core-cut] ${tracked.length} tracked, ${removed.length} removed:`);
for (const [owner, count] of [...byOwner].sort()) console.log(`  ${owner}: ${count}`);

if (argv.has('--list')) {
  for (const [file, owner] of removed) console.log(`  ${owner.padEnd(12)} ${file}`);
  process.exit(0);
}

const requestedOut = valueOf('--out');
/**
 * Where a named destination lands, created empty.
 *
 * Refused if it already holds anything: the cut copies a tree over it, and a
 * leftover file from an earlier run would survive into the artifact as
 * something the manifest says is not there.
 */
function resolveOut(where) {
  const target = resolve(REPO, where);
  if (existsSync(target) && readdirSync(target).length > 0) {
    console.error(`[core-cut] ${target} is not empty, and the cut would inherit whatever is in it`);
    process.exit(1);
  }
  mkdirSync(target, { recursive: true });
  return target;
}

const scratch =
  requestedOut === undefined
    ? mkdtempSync(join(tmpdir(), 'aflow-core-cut-'))
    : resolveOut(requestedOut);
console.log(`[core-cut] building the cut in ${scratch}`);

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf-8', ...opts });

// `git archive` emits committed content only, which is what a published
// repository would carry — an uncommitted file cannot make the cut look green.
//
// Through a file rather than a shell pipe: the destination is a caller's
// argument, and interpolating it into `sh -c` makes a path containing a quote
// either a confusing syntax error or a way to run commands.
const tarball = join(tmpdir(), `aflow-core-cut-${String(process.pid)}.tar`);
const archive = spawnSync('git', ['archive', '--format=tar', '-o', tarball, 'HEAD'], { cwd: REPO });
if (archive.status !== 0) {
  console.error('[core-cut] could not export the tree');
  process.exit(1);
}
const extracted = spawnSync('tar', ['-xf', tarball, '-C', scratch]);
rmSync(tarball, { force: true });
if (extracted.status !== 0) {
  console.error('[core-cut] could not unpack the exported tree');
  process.exit(1);
}

for (const [file] of removed) {
  const target = join(scratch, file);
  if (existsSync(target)) rmSync(target, { force: true });
}

// Directories the cut emptied. A published repository would not carry them,
// and a tool that treats a directory's presence as a workspace's presence —
// tsc project references did — reads an empty one as still there.
for (const dir of new Set(removed.map(([file]) => file.split('/').slice(0, -1).join('/')))) {
  let current = dir;
  while (current !== '' && current !== '.') {
    const absolute = join(scratch, current);
    if (!existsSync(absolute) || readdirSync(absolute).length > 0) break;
    rmSync(absolute, { recursive: true, force: true });
    current = current.split('/').slice(0, -1).join('/');
  }
}

// A repository is more than its files: a project reference, a workspace glob
// and a Docker COPY all name paths, and a cut that deletes the path without
// the reference produces a tree that cannot compile for a reason nothing in
// the manifest describes. Pruning them is part of the transformation, the same
// way deleting the files is — a real public-core repository would not carry
// the reference either.
const rootTsconfigPath = join(scratch, 'tsconfig.json');
if (existsSync(rootTsconfigPath)) {
  const raw = readFileSync(rootTsconfigPath, 'utf-8');
  const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  const before = parsed.references?.length ?? 0;
  // Tested on the tsconfig, not the directory: deleting a workspace's files
  // leaves the directory behind, so `existsSync` on the path says yes about a
  // workspace that is no longer there.
  parsed.references = (parsed.references ?? []).filter((reference) =>
    existsSync(join(scratch, reference.path, 'tsconfig.json')),
  );
  const dropped = before - parsed.references.length;
  if (dropped > 0) {
    writeFileSync(rootTsconfigPath, `${JSON.stringify(parsed, null, 2)}\n`);
    console.log(`[core-cut] dropped ${dropped} project reference(s) to deleted workspaces`);
  }
}

// Scripts whose command names a path the cut deleted, and COPY lines naming a
// workspace it removed. Both transformations live in `@aflow/schemas` beside
// the manifest, so the guard that calls a reference acceptable and the script
// that makes it acceptable cannot disagree.
const rootPackagePath = join(scratch, 'package.json');
if (existsSync(rootPackagePath)) {
  const pkg = JSON.parse(readFileSync(rootPackagePath, 'utf-8'));
  // Read from the repository rather than the scratch copy: the cut has already
  // deleted these manifests there, and their `name` is what a script spells.
  const removedWorkspaceNames = removed
    .map(([file]) => file)
    .filter((file) => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file))
    .map((file) => {
      try {
        return JSON.parse(readFileSync(join(REPO, file), 'utf-8')).name;
      } catch {
        return undefined;
      }
    })
    .filter((name) => typeof name === 'string');

  const { kept, dropped } = pruneScripts(
    pkg.scripts ?? {},
    removed.map(([file]) => file),
    removedWorkspaceNames,
  );
  // Asked of the cut tree's own runner, after the pass above, because a profile
  // is complete or not only against the workspaces and scripts that survived.
  if (dropped.length > 0)
    writeFileSync(rootPackagePath, `${JSON.stringify({ ...pkg, scripts: kept }, null, 2)}\n`);
  const incomplete = spawnSync(
    process.execPath,
    [join(scratch, 'scripts', 'dev.mjs'), '--incomplete-profiles'],
    {
      cwd: scratch,
      encoding: 'utf-8',
    },
  );
  if (incomplete.status !== 0) {
    console.error(
      `[core-cut] could not list the cut's incomplete dev profiles:\n${incomplete.stderr}`,
    );
    process.exit(1);
  }
  for (const profile of JSON.parse(incomplete.stdout)) {
    for (const [name, command] of Object.entries(kept)) {
      if (new RegExp(`scripts/dev\\.mjs\\b.*--profile ${profile}(?:\\s|$)`).test(command)) {
        delete kept[name];
        dropped.push(name);
      }
    }
  }
  if (dropped.length > 0) {
    pkg.scripts = kept;
    writeFileSync(rootPackagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(
      `[core-cut] dropped ${dropped.length} script(s) naming deleted paths or workspaces:`,
    );
    console.log(`  ${dropped.join(', ')}`);
  }
}

// The environment template, minus keys this edition cannot use. The classification
// already exists in the manifest, so this reads it rather than restating which keys
// are hosted.
const envExamplePath = join(scratch, '.env.example');
if (existsSync(envExamplePath)) {
  const { kept, droppedKeys, droppedSections } = pruneEnvExample(
    readFileSync(envExamplePath, 'utf-8'),
    (key) => ENV_OWNERSHIP[key],
  );
  if (droppedKeys.length > 0) {
    writeFileSync(envExamplePath, kept);
    console.log(
      `[core-cut] dropped ${droppedKeys.length} env key(s) from .env.example` +
        (droppedSections.length > 0 ? `, including section(s): ${droppedSections.join(', ')}` : ''),
    );
  }
}

// Dependencies whose only importers the cut deleted. A shared workspace's
// manifest lists what both editions need, so deleting the files that needed one
// leaves the core installing it for nothing — a public core carrying a
// realtime-video SDK it never imports. Judged from the tree the cut produced,
// so a file that survived still speaks for its dependency.
// Scanned against the WHOLE tree, not the cut of it: the question is whether
// any SURVIVING file imports the dependency, and a dependency with no importer
// at all is a different case that must be kept. Reading only what remains
// collapses the two, and nothing would ever be dropped.
const prunedDependencies = new Set();
const stillDeclared = new Set();

/** Where `--prepare` leaves its account of the pruned dependency graph. */
export const PRUNED_DEPENDENCIES_FILE = 'cut-pruned-dependencies.json';
const removedPathSet = new Set(removed.map(([file]) => file));
const stillHere = (file) => !removedPathSet.has(file);
const importerIndex = buildImporterIndex(
  tracked.filter((file) => /\.(ts|tsx|mts|cts|mjs|js)$/.test(file) && !file.includes('/dist/')),
  (file) => readFileSync(join(REPO, file), 'utf-8'),
);
for (const manifestPath of tracked.filter((file) =>
  /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file),
)) {
  const absolute = join(scratch, manifestPath);
  if (!existsSync(absolute)) continue;
  const workspace = manifestPath.slice(0, -'/package.json'.length);
  const pkg = JSON.parse(readFileSync(absolute, 'utf-8'));
  // Scoped to this workspace: a package another one still imports is not one
  // this manifest may keep declaring, and vice versa.
  const local = new Map(
    [...importerIndex].map(([name, files]) => [
      name,
      files.filter((file) => file.startsWith(`${workspace}/`)),
    ]),
  );
  const dropped = dependenciesWithoutSurvivingImporter(
    Object.keys(pkg.dependencies ?? {}),
    local,
    stillHere,
  );
  // What this workspace still asks for once the dead ones are gone. A package
  // one workspace stops importing is not one the image must lose: `nodemailer`
  // leaves `apps/server` with its cloud mailer and stays because
  // `aflow-executor-user` sends the appliance's mail.
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    if (!dropped.includes(dependency)) stillDeclared.add(dependency);
  }
  for (const dependency of Object.keys(pkg.devDependencies ?? {})) stillDeclared.add(dependency);
  for (const dependency of dropped) delete pkg.dependencies[dependency];
  for (const dependency of dropped) prunedDependencies.add(dependency);
  if (dropped.length > 0) {
    console.log(
      `[core-cut] ${workspace}: dropped ${dropped.join(', ')} — nothing left imports them`,
    );
  }

  // What the manifest itself still says about files that are gone: a published
  // subpath, and a bundler entry. Neither is an import, so no import guard sees
  // either, and a bundler skips an entry it cannot find rather than failing —
  // which is how a package whose `exports` pointed at unwritten files built
  // green.
  const manifestCut = pruneWorkspaceManifest(pkg, workspace, removedPathSet);
  for (const subpath of manifestCut.droppedExports) {
    console.log(`[core-cut] ${workspace}: unpublished ${subpath} — its source is gone`);
  }
  for (const { script, argument } of manifestCut.scriptsNamingRemoved) {
    // Reported, not edited. The one that matters tests for the path it names.
    console.log(`[core-cut] ${workspace}: ${script} still names ${argument}`);
  }

  const changed = dropped.length > 0 || manifestCut.droppedExports.length > 0;
  if (!changed) continue;
  writeFileSync(absolute, `${JSON.stringify(manifestCut.manifest, null, 2)}\n`);
}

const dockerfilePath = join(scratch, 'Dockerfile');
if (existsSync(dockerfilePath)) {
  const workspaces = new Set(
    removed
      .map(([file]) => workspaceOf(file))
      .filter((workspace) => workspace !== undefined && !existsSync(join(scratch, workspace))),
  );
  const { kept, dropped, mixed } = pruneDockerfile(
    readFileSync(dockerfilePath, 'utf-8'),
    workspaces,
  );
  if (dropped > 0) {
    writeFileSync(dockerfilePath, kept);
    console.log(`[core-cut] dropped ${dropped} Dockerfile COPY line(s) for deleted workspaces`);
  }
  for (const line of mixed) {
    console.warn(`[core-cut] COPY names both a deleted and a surviving path, left alone:`);
    console.warn(`  ${line.trim()}`);
  }
}

// The background-work catalog is generated from a registry the cut does not
// change and byte-compared by a test the cut runs, so a task implemented by a
// removed workspace would be documented here and then asserted. Regenerated
// against this tree, which is what the renderer's predicate reads.
{
  const catalogPath = join(scratch, 'docs/architecture/background-work.md');
  if (existsSync(catalogPath)) {
    const before = readFileSync(catalogPath, 'utf-8');
    const after = renderBackgroundWorkCatalog((path) => existsSync(join(scratch, path)));
    if (after !== before) {
      writeFileSync(catalogPath, after);
      console.log('[core-cut] regenerated the background-work catalog for this tree');
    }
  }
}

// A published repository is a repository. Several checks — the lifecycle
// exhaustiveness gate that `yarn typecheck` runs, and the ownership guards
// themselves — ask `git ls-files` what the tree contains, and an exported
// archive carries no `.git` to answer with. Initialising one is not scaffolding
// for the proof: it is the state the public core would actually be published
// in, and the index is what makes the answer match the files on disk.
const gitInit = spawnSync(
  'sh',
  [
    '-c',
    'git init -q . && git add -A && git -c user.email=cut@local -c user.name=cut commit -q -m core-cut',
  ],
  { cwd: scratch },
);
if (gitInit.status !== 0) {
  console.error('[core-cut] could not initialise a repository in the cut');
  process.exit(1);
}

// A caller that only wants the tree — the release builds its image from one,
// so the artifact excludes what the manifest says a public core deletes rather
// than being trusted to. Verification is the other modes' job; doing it here
// would make every release pay for a second install and test run.
if (argv.has('--prepare')) {
  // The lockfile is part of a coherent tree, not a detail of verifying one.
  // Removing workspaces and pruning their dependencies changes what resolution
  // produces, and the Dockerfile installs with `--immutable` — so a tree handed
  // over with the repository's lockfile fails inside the image build with
  // YN0028, several minutes in and with the cause named nowhere near the cut.
  // Lockfile only. A plain install would link a whole dependency tree and run
  // the root postinstall, which builds every surviving package — and the
  // Dockerfile then installs and builds all of it again, in each architecture
  // job. Nothing here needs `node_modules`; what the image needs is a lockfile
  // that matches the tree it is handed.
  const installed = run('yarn', ['install', '--no-immutable', '--mode=update-lockfile'], {
    cwd: scratch,
  });
  if (installed.status !== 0) {
    console.error('[core-cut] the cut tree does not resolve; its lockfile cannot be reconciled');
    process.exit(1);
  }
  // What the cut removed from the dependency graph, beside the tree itself. The
  // SBOM taken from the built image asserts their absence, and deriving that
  // list a second time is how the two come to disagree.
  writeFileSync(
    join(scratch, PRUNED_DEPENDENCIES_FILE),
    `${JSON.stringify({ pruned: [...prunedDependencies].sort(), stillDeclared: [...stillDeclared].sort() }, null, 2)}\n`,
  );
  // A sidecar for `appliance-sbom --pruned`, not part of the published tree: it
  // has no ownership rule, and a public repository committing it would fail its
  // own guard. Kept beside the tree, out of the commit.
  appendFileSync(join(scratch, '.git', 'info', 'exclude'), `${PRUNED_DEPENDENCIES_FILE}\n`);

  // The commit above was made before the lockfile was reconciled, so it carries
  // the repository's own — which names workspaces this tree no longer has, and
  // fails `yarn install --immutable` with YN0028. The tree on disk was right and
  // the commit was wrong, which is the worst shape for this: every check that
  // reads the working tree passes, and only a clone or a push carries the fault.
  // The image build is a clone in effect, and so is the published repository's
  // first commit.
  // The attribution file lists what this tree ships, not what the monorepo does.
  const notices = spawnSync(
    'node',
    [join(scratch, 'scripts/third-party-notices.mjs'), '--modules', join(REPO, 'node_modules')],
    { cwd: scratch, encoding: 'utf-8' },
  );
  if (notices.status !== 0) {
    console.error(notices.stderr);
    console.error('[core-cut] could not regenerate THIRD-PARTY-NOTICES.md for the cut');
    process.exit(1);
  }
  console.log(notices.stdout.trim().replace(/^\[notices\]/, '[core-cut]'));

  const amended = spawnSync(
    'sh',
    [
      '-c',
      'git add -A && git -c user.email=cut@local -c user.name=cut commit -q --amend --no-edit',
    ],
    { cwd: scratch },
  );
  if (amended.status !== 0) {
    console.error('[core-cut] could not fold the reconciled lockfile into the commit');
    process.exit(1);
  }

  // Everything this mode produces has to be IN the commit, because a clone is all
  // a consumer gets: the image build clones in effect, and the published
  // repository's first commit is this one. A file written after the commit passes
  // every check that reads the working tree and fails only for somebody else.
  const leftover = execFileSync('git', ['status', '--porcelain'], {
    cwd: scratch,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter((line) => line.trim() !== '');
  if (leftover.length > 0) {
    console.error('[core-cut] the prepared tree has content outside its commit:');
    for (const line of leftover) console.error(`  ${line.trim()}`);
    console.error('[core-cut] a clone of this commit would not be the tree that was checked.');
    process.exit(1);
  }

  console.log(`[core-cut] prepared ${scratch}`);
  process.exit(0);
}

/** @type {Array<{ cmd: string, args: string[] }>} */
const steps = [
  { cmd: 'yarn', args: ['install', '--no-immutable'] },
  { cmd: 'yarn', args: ['typecheck'] },
];
// Typecheck is not build. A bundler entry naming a deleted file, a Next route
// importing one, a missing asset: none of it reaches `tsc`, and all of it
// reaches a release.
if (argv.has('--build')) steps.push({ cmd: 'yarn', args: ['build'] });
if (argv.has('--test')) steps.push({ cmd: 'yarn', args: ['test'] });

let failed = null;
for (const { cmd, args } of steps) {
  const label = `${cmd} ${args.join(' ')}`;
  console.log(`\n[core-cut] ${label}`);
  const result = run(cmd, args, { cwd: scratch });
  if (result.status !== 0) {
    failed = label;
    break;
  }
}

// The artifact, not the import graph. A closure cannot say what an image
// contains: a COPY the pruning missed, a workspace pulled in as a dependency,
// a build output copied wholesale. Asking the built filesystem can.
if (failed === null && argv.has('--image')) {
  const tag = 'aflow-core-cut:proof';
  console.log('\n[core-cut] docker build');
  const built = run('docker', ['build', '-t', tag, '.'], { cwd: scratch });
  if (built.status !== 0) {
    failed = 'docker build';
  } else {
    // Every inspection is a command that can fail, and a failed command
    // produces no output — which reads as "nothing forbidden is installed".
    // Each one has to have run, and to have found what a working image must
    // contain, before its silence means anything.
    const inspect = (args, what) => {
      const result = spawnSync('docker', ['run', '--rm', '--entrypoint', 'sh', tag, '-c', args], {
        cwd: scratch,
        encoding: 'utf-8',
      });
      if (result.status !== 0) {
        console.error(`[core-cut] could not inspect ${what} (exit ${String(result.status)}):`);
        console.error(`  ${(result.stderr ?? '').trim().split('\n').slice(0, 3).join('\n  ')}`);
        return undefined;
      }
      return (result.stdout ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    };

    const shipped = inspect('ls apps', 'the image workspaces');
    // A listing that came back without the server is not a listing of this
    // image, whatever the exit status said.
    if (!shipped?.includes('server')) {
      console.error('[core-cut] the workspace listing did not name `server` — not trusting it');
      failed = 'image inspection';
    } else {
      const forbidden = shipped.filter((workspace) => {
        const match = ownerOf(`apps/${workspace}/package.json`);
        return match !== undefined && !survivesCoreCut(match.owner);
      });
      console.log(
        `[core-cut] the image ships ${String(shipped.length)} workspace(s): ${shipped.join(', ')}`,
      );
      if (forbidden.length > 0) {
        console.error(
          `[core-cut] the image contains workspaces the cut deletes: ${forbidden.join(', ')}`,
        );
        failed = 'image contents';
      }

      // Asked per package and by path, not by listing `node_modules`. A scoped
      // package appears there as its scope alone — `@auth0`, never
      // `@auth0/nextjs-auth0` — so a name check answers "absent" about
      // something installed, and the next slice to need this is Auth0. The
      // path form also finds a copy nested under another package.
      const pruned = [...prunedDependencies];
      if (pruned.length > 0) {
        const probes = pruned
          .map((name) => `find node_modules -type d -path "*/${name}" -print -quit`)
          .join('; ');
        const found = inspect(probes, 'the installed packages');
        if (found === undefined) {
          failed = 'image inspection';
        } else {
          const installed = pruned.filter((name) =>
            found.some((path) => path.endsWith(`/${name}`)),
          );
          const stillInstalled = installed.filter((name) => !stillDeclared.has(name));
          const keptByAnother = installed.filter((name) => stillDeclared.has(name));
          console.log(
            `[core-cut] pruned ${String(pruned.length)} dependency(ies); ` +
              `${String(keptByAnother.length)} still asked for elsewhere ` +
              `(${keptByAnother.join(', ') || 'none'}); ` +
              `${String(stillInstalled.length)} installed with nothing asking`,
          );
          if (stillInstalled.length > 0) {
            console.error(
              `[core-cut] the image still installs: ${stillInstalled.join(', ')} — another ` +
                'workspace declares them, or they arrive as somebody transitive',
            );
            failed = 'image dependencies';
          }
        }
      }
    }

    run('docker', ['image', 'rm', '-f', tag], { cwd: scratch, stdio: 'ignore' });
  }
}

if (failed !== null) {
  console.error(`\n[core-cut] FAILED at: ${failed}`);
  console.error(`[core-cut] the cut is left at ${scratch} to look at`);
  process.exit(1);
}

const ran = [...steps.map((step) => step.args[0]), ...(argv.has('--image') ? ['image'] : [])];
console.log(`\n[core-cut] the cut is clean: ${ran.join(', ')}`);
if (!argv.has('--keep') && requestedOut === undefined) {
  rmSync(scratch, { recursive: true, force: true });
}
