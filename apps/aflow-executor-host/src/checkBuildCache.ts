/**
 * A folder's check builds, kept by this executor from one check to the next.
 *
 * A check runs in a fresh checkout holding no build and builds every package
 * the change reads, nearly all of them unchanged since the last check. The
 * check is given no path to keep them in: whatever it could write would outlive
 * it, and code in one commit could then shape the builds a later commit's
 * check — the gate behind a push receipt — runs against. So the check only
 * reports which packages it built, what each is built after and which files
 * each build wrote, and this executor does the rest after the sandbox has
 * exited, in the host directory, which no sandbox reads or writes:
 *
 * - a build is keyed by the hash of everything that produced it, read here
 *   from the commit and the machine rather than taken from the check: the
 *   package's tree, the commit's root files, the build tooling — the folder's
 *   installation and the program the checks run — and the key of every package
 *   it is built after;
 * - its files are copied in with a sha-256 each, and the entry's digest, the
 *   hash of that list, recorded apart from it;
 * - before a later check, an entry whose key that commit reproduces and whose
 *   digest holds is copied, never linked, into the new checkout, each file
 *   hashed as it lands; an entry whose digest or a file's hash does not hold
 *   is removed and nothing of it is left in the checkout.
 *
 * Which package a build is built after is the reporting check's word, so the
 * later check is told the graph each build it is handed was keyed over, and
 * builds again any whose graph it does not read itself: a check that
 * misreported its graph keeps builds no other check accepts.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import { z } from 'zod';

import { git } from './worktree.js';

/** Names the file listing the builds this executor copied into a check's checkout. */
export const CHECK_KEPT_BUILDS_ENV = 'AFLOW_CHECK_KEPT_BUILDS';

/** How long a build no check was handed stays kept. */
export const CHECK_BUILD_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The most one kept build may hold; a build that writes more is built every time instead. */
export const CHECK_BUILD_MAX_BYTES = 512 * 1024 * 1024;

const CHECK_BUILDS_DIR = 'check-builds';
const ENTRIES_DIR = 'entries';
const DIGESTS_DIR = 'digests';
const FILES_DIR = 'files';
const MANIFEST_FILE = 'manifest.json';
const INCOMING_PREFIX = '.incoming-';
/** An installation a build reads and never writes, mirrored into the checkout by link. */
const INSTALLATION_DIR = 'node_modules';
/** What a package manager writes into an installation to record what it installed. */
const INSTALLATION_STATE_FILES = ['.yarn-state.yml', '.package-lock.json', '.modules.yaml'];
const EXECUTABLE_BITS = 0o111;
const KEPT_FILE_MODE = 0o644;
const KEPT_EXECUTABLE_MODE = 0o755;
/** Room for `git ls-tree` over a commit's root or one package. */
const GIT_LISTING_MAX_BYTES = 64 * 1024 * 1024;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
/** Pathspecs read as the paths they spell: a reported `:(glob)…` matches nothing more. */
const LITERAL_PATHSPECS_ENV = { GIT_LITERAL_PATHSPECS: '1' };

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

function isPlainRelativePath(path: string): boolean {
  return (
    !isAbsolute(path) &&
    !path.includes('\0') &&
    !path.includes('\\') &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

const RelativePathSchema = z.string().min(1).refine(isPlainRelativePath, {
  message: 'not a plain path inside the repository',
});

/** One package of a check's report: built there where it names the files its build wrote. */
export const CheckBuildSchema = z.object({
  dir: RelativePathSchema,
  after: z.array(RelativePathSchema),
  files: z.array(RelativePathSchema).optional(),
});
export type CheckBuild = z.infer<typeof CheckBuildSchema>;
export const CheckBuildsSchema = z.array(CheckBuildSchema);

/** Each package a key was computed over, with the packages it is built after. */
const GraphSchema = z.array(z.tuple([RelativePathSchema, z.array(RelativePathSchema)]));
type Graph = z.infer<typeof GraphSchema>;

const ManifestSchema = z.object({
  dir: RelativePathSchema,
  graph: GraphSchema,
  files: z.array(
    z.object({
      path: RelativePathSchema,
      sha256: z.string().regex(KEY_PATTERN),
      executable: z.boolean(),
    }),
  ),
});
type Manifest = z.infer<typeof ManifestSchema>;

/** A build copied into a checkout, as the check is told of it. */
export interface KeptBuild {
  readonly dir: string;
  readonly graph: Graph;
  /** Relative to the package. */
  readonly files: readonly string[];
}

/** The build cache of the folder whose repository directory is `gitDir`, in the host directory. */
export function checkBuildCacheDir(hostDir: string, gitDir: string): string {
  return join(hostDir, CHECK_BUILDS_DIR, sha256(gitDir));
}

export interface BuildKeyInputs {
  /** Git's listing of the commit's root files. */
  readonly rootFiles: string;
  readonly tooling: string;
  /** Each package directory's tree id at the commit. */
  readonly trees: ReadonlyMap<string, string>;
}

/**
 * The key of `dir`'s build under `graph`, or nothing where the commit holds no
 * tree for it or for a package it is built after, or the graph is cyclic or
 * does not say what one of them is built after.
 */
export function buildKey(
  dir: string,
  graph: ReadonlyMap<string, readonly string[]>,
  inputs: BuildKeyInputs,
): string | undefined {
  const root = sha256(inputs.rootFiles);
  const keys = new Map<string, string | undefined>();
  const visiting = new Set<string>();
  const keyOf = (current: string): string | undefined => {
    if (keys.has(current)) return keys.get(current);
    const tree = inputs.trees.get(current);
    const after = graph.get(current);
    if (tree === undefined || after === undefined || visiting.has(current)) return undefined;
    visiting.add(current);
    const lines = [`root ${root}`, `tooling ${inputs.tooling}`, `dir ${current} ${tree}`];
    let complete = true;
    for (const earlier of [...new Set(after)].sort()) {
      const key = keyOf(earlier);
      if (key === undefined) {
        complete = false;
        break;
      }
      lines.push(`after ${earlier} ${key}`);
    }
    visiting.delete(current);
    const key = complete ? sha256(lines.join('\n')) : undefined;
    keys.set(current, key);
    return key;
  };
  return keyOf(dir);
}

/** `dir` and every package it is built after, transitively, as `graph` says. */
function closureOf(dir: string, graph: ReadonlyMap<string, readonly string[]>): Graph {
  const closure = new Map<string, string[]>();
  const pending = [dir];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const after = graph.get(current);
    if (closure.has(current) || after === undefined) continue;
    closure.set(current, [...new Set(after)].sort());
    pending.push(...after);
  }
  return [...closure].sort(([a], [b]) => a.localeCompare(b));
}

/** The tree ids `git ls-tree -d -z` lists, by path. */
export function treesFromListing(listing: string): Map<string, string> {
  const trees = new Map<string, string>();
  for (const entry of listing.split('\0')) {
    const match = /^\d+ tree ([0-9a-f]+)\t(.+)$/.exec(entry);
    if (match?.[1] !== undefined && match[2] !== undefined) trees.set(match[2], match[1]);
  }
  return trees;
}

async function keyInputs(
  root: string,
  sha: string,
  dirs: readonly string[],
  tooling: string,
): Promise<BuildKeyInputs> {
  const rootFiles = (await git(root, ['ls-tree', '-z', sha], GIT_LISTING_MAX_BYTES))
    .split('\0')
    .filter((entry) => entry.includes(' blob '))
    .join('\0');
  const trees =
    dirs.length === 0
      ? new Map<string, string>()
      : treesFromListing(
          await git(
            root,
            ['ls-tree', '-d', '-z', '--full-name', sha, '--', ...[...dirs].sort()],
            GIT_LISTING_MAX_BYTES,
            LITERAL_PATHSPECS_ENV,
          ),
        );
  return { rootFiles, tooling, trees };
}

async function resolveProgram(
  program: string,
  cwd: string,
  searchPath: string,
): Promise<string | undefined> {
  const candidates = program.includes('/')
    ? [isAbsolute(program) ? program : join(cwd, program)]
    : searchPath
        .split(delimiter)
        .filter((entry) => entry !== '')
        .map((entry) => join(entry, program));
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (info.isFile() && (info.mode & EXECUTABLE_BITS) !== 0) return resolved;
    } catch {
      // Not on this entry of the path.
    }
  }
  return undefined;
}

/**
 * The build tooling's digest: the state the folder's package manager recorded
 * for its installation, which every checkout links, and the program the checks
 * run, found as the sandbox finds it. Nothing where the folder's installation
 * records no state or the program is not found, so nothing is kept.
 */
export async function buildTooling(
  root: string,
  program: string | undefined,
  cwd: string,
  searchPath: string = process.env['PATH'] ?? '',
): Promise<string | undefined> {
  const parts: string[] = [];
  for (const name of INSTALLATION_STATE_FILES) {
    try {
      parts.push(`${name} ${sha256(await readFile(join(root, INSTALLATION_DIR, name)))}`);
    } catch {
      // This package manager's state is not here.
    }
  }
  if (parts.length === 0 || program === undefined) return undefined;
  const resolved = await resolveProgram(program, cwd, searchPath);
  if (resolved === undefined) return undefined;
  const info = await stat(resolved);
  parts.push(`program ${resolved} ${String(info.size)} ${String(info.mtimeMs)}`);
  return sha256(parts.join('\n'));
}

/**
 * Every directory from `base` down to `relative`, made where absent; false
 * where one of them is anything but a directory — a link above all, through
 * which a write from this executor would land outside the checkout.
 */
async function realDirectories(base: string, relative: string, create: boolean): Promise<boolean> {
  let current = base;
  for (const segment of relative === '.' ? [] : relative.split('/')) {
    current = join(current, segment);
    try {
      if (!(await lstat(current)).isDirectory()) return false;
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      await mkdir(current);
    }
  }
  return true;
}

/** The sha-256 of a regular file read without following a link, and whether it is executable. */
async function hashRegularFile(
  path: string,
): Promise<{ sha256: string; size: number; executable: boolean } | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    // A second link to the file is a way to a file the check could not read.
    if (!info.isFile() || info.nlink !== 1) return undefined;
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
    }
    return {
      sha256: hash.digest('hex'),
      size: info.size,
      executable: (info.mode & EXECUTABLE_BITS) !== 0,
    };
  } finally {
    await handle.close();
  }
}

async function removeEntry(cacheDir: string, key: string): Promise<void> {
  await rm(join(cacheDir, DIGESTS_DIR, key), { force: true });
  await rm(join(cacheDir, ENTRIES_DIR, key), { recursive: true, force: true });
}

/**
 * The manifest of the entry kept as `key`, where its recorded digest holds.
 * An entry whose digest is not recorded yet is passed over; one whose digest
 * does not hold, or whose manifest does not parse, is removed.
 */
async function trustedManifest(cacheDir: string, key: string): Promise<Manifest | undefined> {
  let recorded: string;
  let text: string;
  try {
    recorded = (await readFile(join(cacheDir, DIGESTS_DIR, key), 'utf8')).trim();
    text = await readFile(join(cacheDir, ENTRIES_DIR, key, MANIFEST_FILE), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: ReturnType<typeof ManifestSchema.safeParse> | undefined;
  if (sha256(text) === recorded) {
    try {
      parsed = ManifestSchema.safeParse(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
  }
  if (parsed?.success !== true) {
    await removeEntry(cacheDir, key);
    return undefined;
  }
  return parsed.data;
}

/**
 * Copy the entry kept as `key` into `checkout`, each file hashed where it
 * lands. False, with nothing of it left in the checkout, where a file is not
 * what the manifest recorded — the entry is then removed — or cannot be
 * placed.
 */
async function placeEntry(
  cacheDir: string,
  key: string,
  manifest: Manifest,
  checkout: string,
): Promise<boolean> {
  const placed: string[] = [];
  const undo = async (): Promise<false> => {
    for (const file of placed) await rm(file, { force: true });
    return false;
  };
  for (const file of manifest.files) {
    const relative = `${manifest.dir}/${file.path}`;
    try {
      if (!(await realDirectories(checkout, dirname(relative), true))) return await undo();
      const target = join(checkout, relative);
      await copyFile(
        join(cacheDir, ENTRIES_DIR, key, FILES_DIR, file.path),
        target,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      );
      placed.push(target);
      const landed = await hashRegularFile(target);
      if (landed?.sha256 !== file.sha256) {
        await removeEntry(cacheDir, key);
        return await undo();
      }
      await chmod(target, file.executable ? KEPT_EXECUTABLE_MODE : KEPT_FILE_MODE);
    } catch {
      return await undo();
    }
  }
  return true;
}

/**
 * Copy into `checkout` every kept build whose key the commit `sha` reproduces
 * and whose digests hold — for a package with several, the one a check was
 * handed last — and say which they are.
 */
export async function restoreKeptBuilds(params: {
  readonly cacheDir: string;
  readonly root: string;
  readonly sha: string;
  readonly checkout: string;
  readonly tooling: string | undefined;
  readonly now?: Date;
}): Promise<KeptBuild[]> {
  if (params.tooling === undefined) return [];
  let names: string[];
  try {
    names = (await readdir(join(params.cacheDir, ENTRIES_DIR))).filter((name) =>
      KEY_PATTERN.test(name),
    );
  } catch {
    return [];
  }
  const candidates: Array<{ key: string; manifest: Manifest; usedAt: number }> = [];
  for (const key of names) {
    const manifest = await trustedManifest(params.cacheDir, key);
    if (manifest === undefined) continue;
    const usedAt = (await stat(join(params.cacheDir, ENTRIES_DIR, key))).mtimeMs;
    candidates.push({ key, manifest, usedAt });
  }
  if (candidates.length === 0) return [];
  const dirs = new Set(candidates.flatMap(({ manifest }) => manifest.graph.map(([dir]) => dir)));
  const inputs = await keyInputs(params.root, params.sha, [...dirs], params.tooling);
  const chosen = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const { dir, graph } = candidate.manifest;
    if (buildKey(dir, new Map(graph), inputs) !== candidate.key) continue;
    const held = chosen.get(dir);
    if (held === undefined || held.usedAt < candidate.usedAt) chosen.set(dir, candidate);
  }
  const checkout = await realpath(params.checkout);
  const now = params.now ?? new Date();
  const restored: KeptBuild[] = [];
  for (const { key, manifest } of chosen.values()) {
    if (!(await placeEntry(params.cacheDir, key, manifest, checkout))) continue;
    await utimes(join(params.cacheDir, ENTRIES_DIR, key), now, now);
    restored.push({
      dir: manifest.dir,
      graph: manifest.graph,
      files: manifest.files.map((file) => file.path),
    });
  }
  return restored.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The files of `dir` the commit tracks, relative to the package. */
async function trackedFiles(root: string, sha: string, dir: string): Promise<Set<string>> {
  const listing = await git(
    root,
    ['ls-tree', '-r', '-z', '--name-only', '--full-name', sha, '--', dir],
    GIT_LISTING_MAX_BYTES,
    LITERAL_PATHSPECS_ENV,
  );
  return new Set(
    listing
      .split('\0')
      .filter((path) => path.startsWith(`${dir}/`))
      .map((path) => path.slice(dir.length + 1)),
  );
}

/**
 * Keep one build: every file it names gathered apart, hashed as it is read,
 * and moved into place whole, its digest recorded after. Nothing is kept where
 * a file is not a regular file of the package's own, reached through no link,
 * or the build holds more than `CHECK_BUILD_MAX_BYTES`.
 */
async function keepBuild(
  params: { readonly cacheDir: string; readonly checkout: string },
  key: string,
  dir: string,
  graph: Graph,
  files: readonly string[],
): Promise<boolean> {
  const entries = join(params.cacheDir, ENTRIES_DIR);
  await mkdir(entries, { recursive: true });
  await mkdir(join(params.cacheDir, DIGESTS_DIR), { recursive: true });
  const incoming = await mkdtemp(join(params.cacheDir, INCOMING_PREFIX));
  try {
    const records: Manifest['files'] = [];
    let total = 0;
    for (const file of files) {
      const relative = `${dir}/${file}`;
      if (!(await realDirectories(params.checkout, dirname(relative), false))) return false;
      const source = join(params.checkout, relative);
      const kept = join(incoming, FILES_DIR, file);
      await mkdir(dirname(kept), { recursive: true });
      const before = await hashRegularFile(source);
      if (before === undefined) return false;
      total += before.size;
      if (total > CHECK_BUILD_MAX_BYTES) return false;
      await copyFile(source, kept, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      const copied = await hashRegularFile(kept);
      if (copied?.sha256 !== before.sha256) return false;
      records.push({ path: file, sha256: copied.sha256, executable: before.executable });
    }
    const manifest = JSON.stringify({ dir, graph, files: records } satisfies Manifest);
    await writeFile(join(incoming, MANIFEST_FILE), manifest);
    try {
      await rename(incoming, join(entries, key));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
      throw error;
    }
    const digest = join(params.cacheDir, DIGESTS_DIR, key);
    const pendingDigest = `${digest}${INCOMING_PREFIX}${String(process.pid)}`;
    await writeFile(pendingDigest, sha256(manifest));
    await rename(pendingDigest, digest);
    return true;
  } finally {
    await rm(incoming, { recursive: true, force: true });
  }
}

/**
 * Keep the builds a check reported, read from its checkout once its sandbox
 * has exited: each under the key this executor computes for it at `sha`, of
 * the files its report names that the commit does not track and no
 * installation holds. Returns the packages kept.
 */
export async function keepCheckBuilds(params: {
  readonly cacheDir: string;
  readonly root: string;
  readonly sha: string;
  readonly checkout: string;
  readonly tooling: string | undefined;
  readonly builds: readonly CheckBuild[];
}): Promise<string[]> {
  if (params.tooling === undefined) return [];
  const graph = new Map(params.builds.map((build) => [build.dir, build.after]));
  const dirs = new Set(params.builds.flatMap((build) => [build.dir, ...build.after]));
  const inputs = await keyInputs(params.root, params.sha, [...dirs], params.tooling);
  const checkout = await realpath(params.checkout);
  const kept: string[] = [];
  for (const build of params.builds) {
    if (build.files === undefined || build.files.length === 0) continue;
    const key = buildKey(build.dir, graph, inputs);
    if (key === undefined) continue;
    try {
      await stat(join(params.cacheDir, ENTRIES_DIR, key));
      continue;
    } catch {
      // Not kept yet.
    }
    const tracked = await trackedFiles(params.root, params.sha, build.dir);
    const files = [...new Set(build.files)]
      .filter((file) => !tracked.has(file) && !file.split('/').includes(INSTALLATION_DIR))
      .sort();
    if (files.length === 0) continue;
    const closure = closureOf(build.dir, graph);
    if (await keepBuild({ cacheDir: params.cacheDir, checkout }, key, build.dir, closure, files)) {
      kept.push(build.dir);
    }
  }
  return kept;
}

/** Remove what no check was handed for `maxAgeMs`, and anything left half kept; returns how many went. */
export async function pruneCheckBuilds(
  cacheDir: string,
  maxAgeMs: number = CHECK_BUILD_CACHE_MAX_AGE_MS,
  now: number = Date.now(),
): Promise<number> {
  let removed = 0;
  const stale = async (path: string): Promise<boolean> => {
    try {
      return now - (await stat(path)).mtimeMs > maxAgeMs;
    } catch {
      return false;
    }
  };
  for (const [area, isEntry] of [
    [cacheDir, false],
    [join(cacheDir, ENTRIES_DIR), true],
    [join(cacheDir, DIGESTS_DIR), false],
  ] as const) {
    let names: string[];
    try {
      names = await readdir(area);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(area, name);
      const leftover = name.includes(INCOMING_PREFIX);
      if (!(isEntry || leftover) || !(await stale(path))) continue;
      if (isEntry) await removeEntry(cacheDir, name);
      else await rm(path, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
