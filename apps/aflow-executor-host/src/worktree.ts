/**
 * Worktree-per-run.
 *
 * A harness runs against a checkout of its own rather than the folder the
 * operator has open. That is what makes a run safe to start at any time: the
 * operator's uncommitted work is never staged, stashed, reverted or competed
 * for, and two runs over the same repository cannot collide. It also gives the
 * result a shape worth reviewing — a diff against the commit the run started
 * from, rather than a mutation already applied to the working copy.
 *
 * The worktree is detached at the binding's current HEAD, or at the commit a
 * caller named. Nothing is pushed and a run moves no ref; deciding what becomes
 * of the diff is a separate act, and the most a decision reaches from here is a
 * branch of its own or one commit appended to the branch the diff was made on.
 *
 * It carries only what the repository tracks, so the operator's installed
 * dependencies are linked into it: without them a harness asked to run the
 * tests reaches for a package registry the boundary denies.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
/** A diff large enough to be a build directory is a mistake, not a change set. */
const DIFF_CAP_BYTES = 2 * 1024 * 1024;
/**
 * Room for what an apply says about itself, which is a line per file and so
 * grows with the diff rather than being bounded by it. Node kills a child that
 * overruns its buffer, and killing `git apply` partway through leaves a tree
 * half-written — the one outcome this operation promises cannot happen. Sized
 * well past any diff the input cap admits, because the cost of slack here is
 * memory and the cost of shortfall is a corrupted working copy.
 */
const APPLY_OUTPUT_CAP_BYTES = 16 * 1024 * 1024;

export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'not_a_repository'
      | 'unborn_head'
      | 'git_failed'
      | 'branch_exists'
      | 'branch_checked_out'
      | 'no_identity'
      | 'unknown_ref'
      | 'stale_base',
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

/**
 * What git is allowed to be, when this lane runs it.
 *
 * These commands run OUTSIDE the sandbox — they have to, since they create the
 * worktree the sandbox is then compiled around. That makes them the one place
 * repository-controlled behaviour could execute with the executor's own
 * authority: `worktree add` performs a checkout, which runs `post-checkout` and
 * `filter.*.smudge`, and `git add` runs clean filters. Inheriting this
 * process's environment handed those the pairing credential and the Redis URL.
 *
 * So hooks are off, the global config is not read, and the environment is the
 * few variables git needs rather than everything this executor holds. The
 * repository is still the operator's own — this is about what it can reach if
 * it turns out not to be.
 *
 * The global config is the part that took a second look. `core.hooksPath` stops
 * hooks and `protocol.ext.allow` stops transport helpers, but neither touches
 * `filter.<name>.smudge`, `.clean` or `.process` — and those are programs git
 * runs too. A filter is *selected* by `.gitattributes`, which lives in the
 * working tree and which a harness may write, and *defined* in config. Checking
 * a worktree out and staging with `git add -A` both apply them, here, outside
 * the sandbox, with the operator's PATH.
 *
 * Naming filters to disable does not work: the set is whatever the operator has
 * configured. Removing where they are defined does. System config is already
 * off; global is pointed at nothing; what remains is the repository's own
 * `.git/config`, which this lane refuses to let anything write.
 */
const GIT_SAFETY_ARGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=',
  '-c',
  'protocol.ext.allow=never',
];

/**
 * Minimal, and deliberately without `REDIS_URL` or `PHOENIX_INSTANCE_SECRET`.
 * `PATH` and `HOME` are what git needs to find itself and its config; the rest
 * of this executor's environment is none of its business.
 */
function gitEnv(globalConfig: 'withheld' | 'read' = 'withheld'): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
  };
  // Withheld for everything that checks out, stages or commits — which is
  // everything but the two identity strings read below.
  if (globalConfig === 'withheld') env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (globalConfig === 'read') {
    const configured = process.env['GIT_CONFIG_GLOBAL'];
    if (configured !== undefined) env['GIT_CONFIG_GLOBAL'] = configured;
  }
  return env;
}

async function git(cwd: string, args: string[], maxBuffer = 1024 * 1024): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...GIT_SAFETY_ARGS, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: gitEnv(),
  });
  return stdout;
}

/**
 * The directory a checkout inherits rather than fetches again.
 *
 * A worktree is created at a commit, so it carries what the repository tracks
 * and nothing else — and installed dependencies are, correctly, not tracked. A
 * harness asked to run the tests or the typecheck therefore reaches for the
 * package registry, which the boundary denies, and reports a network failure
 * for work the operator's own machine could already do. Linking the folder's
 * installation in is what makes the checkout runnable.
 *
 * By directory name, with no ecosystem named anywhere: which manifest put it
 * there, and whether it is one package or a workspace, is none of this lane's
 * business.
 */
const DEPENDENCY_DIR = 'node_modules';

/**
 * How far down the folder is searched. A workspace keeps one installation at
 * the root and one per package, which is this depth; going further would walk
 * trees whose size belongs to the operator rather than to this run, on every
 * run and every collection.
 */
const DEPENDENCY_SCAN_DEPTH = 3;

/**
 * Every `node_modules` within reach, as paths relative to `base`.
 *
 * A link counts. A folder whose installation lives elsewhere on disk still has
 * one, and asking only for a real directory left such a folder with nothing
 * carried into the checkout at all.
 *
 * Never descends into one: the inside of an installation is the largest tree on
 * the machine, and what this lane wants from it is its entries, not its depth.
 */
async function dependencyDirs(base: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > DEPENDENCY_SCAN_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(join(base, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relative === '' ? entry.name : join(relative, entry.name);
      if (entry.name === DEPENDENCY_DIR) {
        if (entry.isDirectory() || entry.isSymbolicLink()) found.push(child);
        continue;
      }
      if (entry.name === '.git' || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      await walk(child, depth + 1);
    }
  };
  await walk('', 1);
  return found;
}

interface MirrorContext {
  /** The connected folder, resolved, so containment is decided on real paths. */
  readonly rootReal: string;
  readonly worktreePath: string;
}

/**
 * Where one entry of the operator's installation should point from inside the
 * checkout.
 *
 * A workspace package manager puts links in `node_modules` that lead back into
 * the repository — `@scope/pkg -> ../../packages/pkg`. Reached through a link
 * to the operator's installation, every one of those resolves into the folder
 * the operator is editing, so a harness typechecking the checkout read source
 * that was never committed and the promise that a run sees committed work only
 * was false on any workspace.
 *
 * So an entry that resolves to a path the repository itself carries is pointed
 * at the checkout's copy of that path, where the committed version is. An entry
 * that resolves anywhere else — a real dependency, or a link landing within an
 * installation — is pointed at the operator's, which is the tree this lane will
 * not duplicate.
 */
async function mirrorTarget(entryPath: string, context: MirrorContext): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(entryPath);
  } catch {
    return entryPath;
  }
  if (!resolved.startsWith(context.rootReal + sep)) return entryPath;
  const inside = resolved.slice(context.rootReal.length + 1);
  if (inside.split(sep).includes(DEPENDENCY_DIR)) return entryPath;
  return join(context.worktreePath, inside);
}

/**
 * Recreate an installation's surface in the checkout, one link per entry.
 *
 * The directory is real and its entries are links: nothing is copied, and a
 * scope is opened one level further because `@scope` names a shelf of packages
 * rather than a package.
 *
 * Best effort per entry. A checkout missing one is still a checkout.
 */
async function mirrorInstallation(
  source: string,
  destination: string,
  context: MirrorContext,
  expandScopes: boolean,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch {
    return;
  }
  try {
    await mkdir(destination, { recursive: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (expandScopes && entry.name.startsWith('@')) {
      await mirrorInstallation(from, to, context, false);
      continue;
    }
    await symlink(await mirrorTarget(from, context), to).catch(() => {});
  }
}

/**
 * Point the checkout at the operator's installed dependencies.
 *
 * Links rather than copies: an installation is gigabytes and is identical to
 * the one already on disk. What they reach is readable and not writable — the
 * sandbox grants writes to the worktree by path, and a write through a link
 * lands on the folder's own directory, which the harness's policy withholds. So
 * a harness can run the tests and cannot corrupt what the operator installed.
 */
async function linkDependencies(root: string, worktreePath: string): Promise<void> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    rootReal = root;
  }
  const context: MirrorContext = { rootReal, worktreePath };
  for (const relative of await dependencyDirs(root)) {
    const destination = join(worktreePath, relative);
    try {
      // Only where the checkout has the same place to put it, and has nothing
      // there already — a tracked directory of that name is the repository's.
      if (!(await lstat(dirname(destination))).isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      await lstat(destination);
      continue;
    } catch {
      // Absent, which is the case this fills.
    }
    await mirrorInstallation(join(root, relative), destination, context, true);
  }
}

/**
 * Take a mirrored installation away without following any part of it.
 *
 * Every removal acts on the link itself, and a directory goes only if emptying
 * it left it empty. That is the property the whole arrangement rests on: a
 * removal that reached through a link would take the operator's installed
 * dependencies, or the repository's own package, with the checkout.
 */
async function removeMirror(directory: string): Promise<void> {
  let info;
  try {
    info = await lstat(directory);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) {
    await unlink(directory).catch(() => {});
    return;
  }
  if (!info.isDirectory()) return;

  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      await unlink(child).catch(() => {});
      continue;
    }
    // A real directory here is a mirrored scope, whose entries are links.
    if (!entry.isDirectory()) continue;
    const scope = await readdir(child, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const inner of scope) {
      if (inner.isSymbolicLink()) await unlink(join(child, inner.name)).catch(() => {});
    }
    await rmdir(child).catch(() => {});
  }
  await rmdir(directory).catch(() => {});
}

async function unlinkDependencies(worktreePath: string): Promise<void> {
  for (const relative of await dependencyDirs(worktreePath)) {
    await removeMirror(join(worktreePath, relative));
  }
}

export interface PreparedWorktree {
  /** Absolute path the harness runs in. */
  readonly path: string;
  /** Commit the run started from, so the diff has a stated base. */
  readonly baseSha: string;
}

export async function isGitRepository(root: string): Promise<boolean> {
  try {
    return (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

export interface PrepareWorktreeOptions {
  /**
   * Whether the checkout carries the folder's installed dependencies. A harness
   * needs them to run anything; a checkout that exists only to hold a commit
   * needs none, and linking a workspace's installation costs more than the
   * commit does.
   */
  readonly dependencies?: 'linked' | 'none';
  /** The commit to detach at, already resolved. Absent means the folder's HEAD. */
  readonly at?: string;
}

/**
 * The commit a caller-named ref points at, or a refusal naming the ref.
 *
 * `^{commit}` peels an annotated tag to what it tags, and a ref that names a
 * tree or a blob is refused rather than checked out as something it is not.
 */
export async function resolveCommit(root: string, ref: string): Promise<string> {
  try {
    return (
      await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
    ).trim();
  } catch {
    throw new WorktreeError(
      `\`${ref}\` names no commit in ${root}. Name a branch, a tag or a commit the folder has.`,
      'unknown_ref',
    );
  }
}

export async function prepareWorktree(
  root: string,
  scratchDir: string,
  runKey: string,
  options: PrepareWorktreeOptions = {},
): Promise<PreparedWorktree> {
  if (!(await isGitRepository(root))) {
    throw new WorktreeError(
      `${root} is not a git repository, so a coding run has nothing to branch from.`,
      'not_a_repository',
    );
  }

  let baseSha: string;
  if (options.at !== undefined) {
    baseSha = options.at;
  } else {
    try {
      baseSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
    } catch {
      throw new WorktreeError(
        `${root} has no commits yet. Make an initial commit before running a coding harness.`,
        'unborn_head',
      );
    }
  }

  const path = join(scratchDir, runKey);
  try {
    await git(root, ['worktree', 'add', '--detach', path, baseSha]);
  } catch (error) {
    throw new WorktreeError(
      `Could not create a worktree for this run: ${error instanceof Error ? error.message : String(error)}`,
      'git_failed',
    );
  }
  if ((options.dependencies ?? 'linked') === 'linked') await linkDependencies(root, path);
  return { path, baseSha };
}

export interface WorktreeChanges {
  /** Unified diff against `baseSha`, empty when the harness changed nothing. */
  readonly patch: string;
  readonly filesChanged: number;
  /** True when the diff was capped, so a caller never reports it as complete. */
  readonly truncated: boolean;
}

/**
 * Collect what the harness did. Untracked files are staged first — a harness
 * that adds a file has changed the tree, and a diff that silently omitted new
 * files would be the most misleading possible answer.
 */
export async function collectChanges(worktreePath: string): Promise<WorktreeChanges> {
  // The mirrored installations are this lane's own doing, not the harness's
  // work, and git sees a directory of untracked symlinks that `add -A` would
  // stage. They cannot be removed instead: a session keeps its checkout across
  // turns, and the next turn would find nothing installed. They are handed to
  // git as an ignore list for this one command rather than as exclude
  // pathspecs: a repository that already ignores `node_modules` makes a
  // pathspec naming it an error, while an ignore rule for an ignored path is
  // simply redundant.
  const mirrors = await dependencyDirs(worktreePath);
  const excludes = join(tmpdir(), `aflow-collect-${String(process.pid)}-${randomUUID()}`);
  await writeFile(excludes, mirrors.map((relative) => `/${relative}\n`).join(''), 'utf8');
  try {
    await git(worktreePath, ['-c', `core.excludesFile=${excludes}`, 'add', '-A', '--', '.']);
  } catch (error) {
    throw new WorktreeError(
      `Could not read what the harness changed: ${error instanceof Error ? error.message.split('\n')[0] : 'git failed'}`,
      'git_failed',
    );
  } finally {
    await rm(excludes, { force: true });
  }
  const nameOnly = await git(worktreePath, ['diff', '--cached', '--name-only']);
  const filesChanged = nameOnly.split('\n').filter((line) => line.length > 0).length;
  if (filesChanged === 0) {
    return { patch: '', filesChanged: 0, truncated: false };
  }

  let patch: string;
  let truncated = false;
  try {
    // `--no-textconv` and `--no-ext-diff`: a harness can write `.gitattributes`,
    // and both a textconv driver and an external diff command are programs the
    // operator's own git config names and git runs here — outside the sandbox
    // the harness was confined to. The diff is wanted verbatim in any case.
    patch = await git(
      worktreePath,
      ['diff', '--cached', '--no-textconv', '--no-ext-diff'],
      DIFF_CAP_BYTES,
    );
  } catch {
    // maxBuffer overrun is the expected failure for an oversized diff; the file
    // list still stands, so the run reports what changed without the body.
    patch = '';
    truncated = true;
  }
  if (patch.length > DIFF_CAP_BYTES) {
    patch = patch.slice(0, DIFF_CAP_BYTES);
    truncated = true;
  }
  return { patch, filesChanged, truncated };
}

/**
 * Remove the worktree. Failure here is never allowed to fail the run — the work
 * is already collected, and a leftover directory is a housekeeping problem
 * rather than a reason to discard a result.
 */
export async function removeWorktree(root: string, worktreePath: string): Promise<void> {
  await unlinkDependencies(worktreePath);
  try {
    await git(root, ['worktree', 'remove', '--force', worktreePath]);
  } catch {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    await git(root, ['worktree', 'prune']).catch(() => {});
  }
}

/**
 * Whether the diff still fits the repository it came from.
 *
 * A run's result is a patch against the commit it started from, and by the time
 * anyone looks at it the operator may have committed, pulled or edited the same
 * lines. Saying so is the difference between a diff that can be taken and one
 * that needs a decision, and the answer has to come from git rather than from
 * comparing shas — a moved HEAD that touched other files still applies.
 */
export type ApplyCheck =
  | { readonly state: 'clean' }
  | { readonly state: 'conflict'; readonly detail: string }
  | { readonly state: 'empty' };

export async function checkApplies(root: string, patch: string): Promise<ApplyCheck> {
  if (patch === '') return { state: 'empty' };

  const scratch = await mkdtemp(join(tmpdir(), 'aflow-apply-'));
  const patchPath = join(scratch, 'run.patch');
  try {
    await writeFile(patchPath, patch, 'utf8');
    await git(root, ['apply', '--check', patchPath]);
    return { state: 'clean' };
  } catch (error) {
    // git names the file and hunk it could not place, which is the whole of
    // what makes a conflict resolvable.
    const message = error instanceof Error ? error.message : String(error);
    const detail =
      message
        .split('\n')
        .filter((line) => line.startsWith('error:'))
        .join('; ') || 'The patch does not apply to the repository as it stands.';
    return { state: 'conflict', detail };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The commit the binding is on now, for a caller reporting how far it moved. */
export async function currentHead(root: string): Promise<string | undefined> {
  try {
    return (await git(root, ['rev-parse', 'HEAD'])).trim();
  } catch {
    return undefined;
  }
}

/** Every ref the repository holds, by name, with the object it points at. */
export type RefSnapshot = ReadonlyMap<string, string>;

/**
 * The refs a run could reach, read before and after it.
 *
 * A worktree shares refs with the repository it was added to, so a harness
 * that runs `git branch -D` or `git update-ref` in its checkout rewrites the
 * operator's branches. Read from the connected folder, the listing holds the
 * shared refs and not the run's own detached HEAD, which is the one ref a run
 * moves by committing in its checkout.
 */
export async function snapshotRefs(root: string): Promise<RefSnapshot> {
  const listing = await git(
    root,
    ['for-each-ref', '--format=%(refname) %(objectname)'],
    APPLY_OUTPUT_CAP_BYTES,
  );
  const refs = new Map<string, string>();
  for (const line of listing.split('\n')) {
    const space = line.lastIndexOf(' ');
    if (space <= 0) continue;
    refs.set(line.slice(0, space), line.slice(space + 1));
  }
  return refs;
}

export type RefChange =
  | { readonly ref: string; readonly change: 'created'; readonly after: string }
  | { readonly ref: string; readonly change: 'deleted'; readonly before: string }
  | {
      readonly ref: string;
      readonly change: 'moved';
      readonly before: string;
      readonly after: string;
    };

export function changedRefs(before: RefSnapshot, after: RefSnapshot): RefChange[] {
  const changes: RefChange[] = [];
  for (const [ref, was] of before) {
    const now = after.get(ref);
    if (now === undefined) changes.push({ ref, change: 'deleted', before: was });
    else if (now !== was) changes.push({ ref, change: 'moved', before: was, after: now });
  }
  for (const [ref, now] of after) {
    if (!before.has(ref)) changes.push({ ref, change: 'created', after: now });
  }
  return changes.sort((a, b) => a.ref.localeCompare(b.ref));
}

export function describeRefChanges(changes: readonly RefChange[]): string {
  const lines = changes.map((c) => {
    if (c.change === 'created') return `\`${c.ref}\` was created at ${c.after}`;
    if (c.change === 'deleted') return `\`${c.ref}\` was deleted (it was at ${c.before})`;
    return `\`${c.ref}\` moved from ${c.before} to ${c.after}`;
  });
  return (
    'The run changed refs in the repository it does not own, which a commission may not do: ' +
    `${lines.join('; ')}. Nothing was restored — restore them from the reflog. What the run ` +
    'changed in its checkout is on this error.'
  );
}

/**
 * Every path a diff will touch, taken from git rather than parsed by hand.
 *
 * Two sources, because neither is complete alone. `--numstat -z` lists what a
 * patch writes, NUL-separated so a filename containing a tab or a newline
 * survives; but for a rename it names only the destination, and the source —
 * which apply deletes — never appears. `--summary` names that source. A gate
 * that saw only the destination would let `rename from .git/config` through and
 * fall back on git refusing it itself, which is the single implementation this
 * gate exists not to depend on.
 */
export async function patchPaths(root: string, patch: string): Promise<string[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'aflow-paths-'));
  const patchPath = join(scratch, 'run.patch');
  try {
    await writeFile(patchPath, patch, 'utf8');
    const paths = new Set<string>();

    const numstat = await git(root, ['apply', '--numstat', '-z', patchPath], DIFF_CAP_BYTES);
    for (const record of numstat.split('\0')) {
      if (record === '') continue;
      // `added\tdeleted\tpath` — split on the first two tabs only, because the
      // path may contain tabs of its own and everything after them is the name.
      const firstTab = record.indexOf('\t');
      const secondTab = record.indexOf('\t', firstTab + 1);
      if (firstTab === -1 || secondTab === -1) {
        throw new WorktreeError(
          'A record in this diff does not have the shape git documents, so which files it ' +
            'touches cannot be established.',
          'git_failed',
        );
      }
      const path = record.slice(secondTab + 1);
      if (path !== '') paths.add(path);
    }

    // Rename and copy sources, which numstat leaves out.
    const summary = await git(root, ['apply', '--summary', patchPath], DIFF_CAP_BYTES);
    for (const line of summary.split('\n')) {
      const match = /^\s*(?:rename|copy)\s+(.*?)\s+=>\s+(.*?)(?:\s+\(\d+%\))?\s*$/.exec(line);
      if (match?.[1] !== undefined && match[1] !== '') paths.add(match[1]);
      if (match?.[2] !== undefined && match[2] !== '') paths.add(match[2]);
    }

    return [...paths];
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    throw new WorktreeError(
      `This is not a diff git can read: ${error instanceof Error ? error.message.split('\n')[0] : 'unreadable'}`,
      'git_failed',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface ApplyOutcome {
  readonly state: 'applied' | 'conflict';
  readonly conflicts: string[];
  /**
   * True when the working tree was changed despite the conflict — a three-way
   * apply writes what it could settle and leaves markers in what it could not.
   * A caller reporting "nothing was applied" over this would be wrong.
   */
  readonly wroteTree?: boolean;
  readonly detail?: string;
}

/**
 * Apply a diff to a working tree, whole or not at all.
 *
 * `clean` refuses anything that does not fit exactly, which is the mode worth
 * defaulting to: a diff applied approximately is a change nobody reviewed.
 * `merge` reconciles against a moved base and can leave markers behind, so the
 * files it could not settle are named rather than left to be discovered.
 */
export async function applyPatch(
  root: string,
  patch: string,
  mode: 'clean' | 'merge',
): Promise<ApplyOutcome> {
  const scratch = await mkdtemp(join(tmpdir(), 'aflow-apply-'));
  const patchPath = join(scratch, 'run.patch');
  try {
    await writeFile(patchPath, patch, 'utf8');
    // Hooks are off for the apply as well. Nothing in a patch should be able to
    // choose what runs, and applying one can trigger a filter.
    const args = ['apply'];
    if (mode === 'merge') args.push('--3way');
    args.push(patchPath);

    try {
      await git(root, args, APPLY_OUTPUT_CAP_BYTES);
      return { state: 'applied', conflicts: [] };
    } catch (error) {
      // A three-way apply reports a conflict on STDOUT ("U <path>") and exits
      // non-zero, having already written the tree. Reading only the exception's
      // message — which carries stderr — reported no conflicts over a modified
      // working copy, which is the one answer that must never be given.
      const streams = error as { stdout?: string; stderr?: string };
      const stdout = streams.stdout ?? '';
      const stderr = streams.stderr ?? (error instanceof Error ? error.message : String(error));

      const conflicts = [
        ...new Set(
          [...stdout.split('\n'), ...stderr.split('\n')]
            .map((line) => /^U\s+(.+?)\s*$/.exec(line)?.[1])
            .filter((path): path is string => path !== undefined && path !== ''),
        ),
      ];

      // Whether anything was written decides what this is: a clean apply that
      // failed changed nothing, a three-way that conflicted changed the tree.
      const applied = /^Applied patch to /m.test(stdout) || conflicts.length > 0;

      const detail =
        [...stderr.split('\n'), ...stdout.split('\n')]
          .filter((line) => line.startsWith('error:') || line.startsWith('CONFLICT'))
          .join('; ') ||
        (applied
          ? 'The patch applied with conflicts; the named files carry markers.'
          : 'The patch does not apply to the folder as it stands.');

      return { state: 'conflict', conflicts, wroteTree: applied, detail };
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The name and address a commit made here will carry.
 *
 * Global config is withheld from everything else this lane runs, because a
 * `filter.*`, `diff.*` or credential-helper definition there names a program git
 * executes outside the sandbox. Reading two strings executes nothing, and the
 * distinction is worth drawing: almost no repository carries a local identity,
 * so refusing to look at the global one meant refusing the commit on nearly
 * every folder an operator would connect.
 *
 * Each field resolves on its own — the repository first, then the global config
 * — so a repository that overrides only the address keeps its own.
 */
const NO_IDENTITY_MESSAGE =
  'Neither this repository nor the global git config names a commit identity, so a commit made ' +
  'here would carry none. Set `user.name` and `user.email` in the repository, or globally, ' +
  'then run this again.';

interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

async function configuredValue(
  cwd: string,
  args: string[],
  globalConfig: 'withheld' | 'read',
): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...GIT_SAFETY_ARGS, 'config', ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: gitEnv(globalConfig),
    });
    const value = stdout.trim();
    return value === '' ? undefined : value;
  } catch {
    // An unset key exits non-zero, which is an answer rather than a failure.
    return undefined;
  }
}

async function resolveCommitIdentity(cwd: string): Promise<CommitIdentity | undefined> {
  const resolve = async (key: string): Promise<string | undefined> =>
    (await configuredValue(cwd, ['--get', key], 'withheld')) ??
    (await configuredValue(cwd, ['--global', '--get', key], 'read'));
  const name = await resolve('user.name');
  const email = await resolve('user.email');
  if (name === undefined || email === undefined) return undefined;
  return { name, email };
}

/** Whether the repository already has this branch, asked before anything is built. */
export async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, [
      'show-ref',
      '--verify',
      '--quiet',
      '--end-of-options',
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The checkout that has this branch open, if any.
 *
 * Advancing a branch some checkout is on leaves that checkout's files and index
 * at the old commit while its branch names the new one, so its next commit
 * would quietly revert the change. Git refuses to move such a branch for the
 * same reason.
 */
async function checkoutHolding(root: string, branch: string): Promise<string | undefined> {
  const listing = await git(root, ['worktree', 'list', '--porcelain'], APPLY_OUTPUT_CAP_BYTES);
  let path: string | undefined;
  for (const line of listing.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}

export interface PatchCommit {
  readonly branch: string;
  readonly sha: string;
  /** The parent of the new commit. */
  readonly baseSha: string;
  /** True when the branch existed and the commit was appended to it. */
  readonly appended: boolean;
}

export interface PatchCommitOutcome {
  readonly apply: ApplyOutcome;
  /** Absent when the patch conflicted, which leaves no commit and no branch moved. */
  readonly commit?: PatchCommit;
}

/**
 * Where a commit lands, decided before any checkout is made: the folder's HEAD
 * for a new branch, the branch's head for an existing one. A stated base must
 * be that commit — a patch lands only where it was made, never merged onto
 * something that moved since.
 */
async function commitTarget(
  root: string,
  branch: string,
  base: string | undefined,
): Promise<{ at: string | undefined; appended: boolean }> {
  const appended = await branchExists(root, branch);
  const stated = base === undefined ? undefined : await resolveCommit(root, base);

  if (appended) {
    if (stated === undefined) {
      throw new WorktreeError(
        `The repository already has a branch \`${branch}\`. A commit is appended to it only ` +
          'with `base`: the commit the patch was made against, as the commission reported it in ' +
          '`baseSha`. A fresh change takes a new branch name.',
        'branch_exists',
      );
    }
    const head = await resolveCommit(root, `refs/heads/${branch}`);
    if (stated !== head) {
      throw new WorktreeError(
        `The patch was made against \`${base ?? stated}\` but \`${branch}\` is at \`${head}\`. ` +
          'A patch is appended only to the commit it was made against, never merged onto a ' +
          `branch that has moved; commission the fix again from \`${branch}\`.`,
        'stale_base',
      );
    }
    const holder = await checkoutHolding(root, branch);
    if (holder !== undefined) {
      throw new WorktreeError(
        `\`${branch}\` is checked out in ${holder}, and advancing it would leave that checkout's ` +
          'files behind its own branch. Switch that checkout off the branch, then publish again.',
        'branch_checked_out',
      );
    }
    return { at: head, appended };
  }

  if (stated !== undefined) {
    const head = await currentHead(root);
    if (head !== undefined && stated !== head) {
      throw new WorktreeError(
        `The patch was made against \`${base ?? stated}\` but the folder's last commit is ` +
          `\`${head}\`. Publish from a commission that started at the folder's HEAD, or name the ` +
          'branch it started from.',
        'stale_base',
      );
    }
  }
  return { at: undefined, appended };
}

/**
 * Land a diff as a commit on a branch, without touching what the operator has
 * open.
 *
 * A new branch starts at the folder's HEAD; an existing one takes the commit on
 * top of its head, provided the patch was made there. The apply happens in a
 * checkout made for this call alone, so the operator's working tree, index and
 * current branch are never a party to it — they are a second writer this lane
 * does not get to interrupt. What remains afterwards is one ref, created or
 * advanced by one commit, which is the thing a publication can push and the
 * thing an operator can reset if they disagree.
 *
 * The identity is the operator's own, resolved from the repository's config and
 * then from their global one. Inventing an author for a commit that will carry
 * the operator's name is not this lane's to do, so a folder where neither names
 * one is refused rather than signed.
 */
export async function commitPatchOnBranch(
  root: string,
  patch: string,
  mode: 'clean' | 'merge',
  branch: string,
  message: string,
  base?: string,
): Promise<PatchCommitOutcome> {
  const target = await commitTarget(root, branch, base);

  const scratch = await mkdtemp(join(tmpdir(), 'aflow-commit-'));
  let worktree: PreparedWorktree | undefined;
  try {
    worktree = await prepareWorktree(root, scratch, 'commit', {
      dependencies: 'none',
      ...(target.at !== undefined ? { at: target.at } : {}),
    });
    const apply = await applyPatch(worktree.path, patch, mode);
    if (apply.state === 'conflict') return { apply };

    await git(worktree.path, ['add', '-A', '--', '.'], APPLY_OUTPUT_CAP_BYTES);
    const staged = await git(worktree.path, ['diff', '--cached', '--name-only']);
    if (staged.trim() === '') {
      throw new WorktreeError(
        'The patch applied and changed nothing, so there is no commit to make.',
        'git_failed',
      );
    }

    const identity = await resolveCommitIdentity(worktree.path);
    if (identity === undefined) throw new WorktreeError(NO_IDENTITY_MESSAGE, 'no_identity');

    const messagePath = join(scratch, 'commit-message');
    await writeFile(messagePath, message, 'utf8');
    try {
      // The identity is passed in, and `user.useConfigOnly` keeps git's own
      // fallback off: a name and address built from the account and the
      // hostname would land in the operator's history as an author they never
      // chose.
      await git(
        worktree.path,
        [
          '-c',
          'user.useConfigOnly=true',
          '-c',
          `user.name=${identity.name}`,
          '-c',
          `user.email=${identity.email}`,
          'commit',
          '-F',
          messagePath,
        ],
        APPLY_OUTPUT_CAP_BYTES,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (
        /Please tell me who you are|no email was given|unable to auto-detect|empty ident/i.test(
          detail,
        )
      ) {
        throw new WorktreeError(NO_IDENTITY_MESSAGE, 'no_identity');
      }
      throw new WorktreeError(
        `The commit could not be made: ${detail.split('\n')[0] ?? 'git failed'}`,
        'git_failed',
      );
    }

    const sha = (await git(worktree.path, ['rev-parse', 'HEAD'])).trim();
    try {
      // Compare-and-swap on the old head: a branch that moved between the check
      // above and this line is refused here rather than overwritten.
      await git(
        worktree.path,
        target.appended
          ? ['update-ref', '--end-of-options', `refs/heads/${branch}`, sha, worktree.baseSha]
          : ['branch', '--end-of-options', branch, sha],
      );
    } catch (error) {
      throw new WorktreeError(
        `The commit was made but \`${branch}\` could not be ${
          target.appended ? 'advanced' : 'created'
        }: ${error instanceof Error ? (error.message.split('\n')[0] ?? 'git failed') : 'git failed'}`,
        'git_failed',
      );
    }
    return {
      apply,
      commit: { branch, sha, baseSha: worktree.baseSha, appended: target.appended },
    };
  } finally {
    if (worktree !== undefined) await removeWorktree(root, worktree.path);
    await rm(scratch, { recursive: true, force: true });
  }
}
