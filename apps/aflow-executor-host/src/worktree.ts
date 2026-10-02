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
 * caller named. Nothing is pushed, and the agent's ordinary git is refused a
 * branch or tag move (`refGuard.ts`); deciding what becomes of the diff is a separate act, and the
 * most a decision reaches from here is a branch of its own or one commit
 * appended to the branch the diff was made on.
 *
 * It carries only what the repository tracks, so the operator's installed
 * dependencies are linked into it: without them a harness asked to run the
 * tests reaches for a package registry the boundary denies.
 */
import { execFile, spawn } from 'node:child_process';
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
import {
  dirname,
  isAbsolute,
  join,
  relative as relativePath,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
/**
 * The largest diff a run keeps and a patch applies. Past it the diff is a build
 * directory, which is a mistake rather than a change set. It stays well under
 * `APPLY_OUTPUT_CAP_BYTES`, which is sized against it.
 */
export const DIFF_CEILING_BYTES = 8 * 1024 * 1024;
/** How much of a diff a run's result carries inline, for reading. */
export const INLINE_DIFF_CAP_BYTES = 2 * 1024 * 1024;

/**
 * The longest start of `text` that fits in `maxBytes` of UTF-8. The cut lands
 * on a character boundary: a cut inside a multi-byte character decodes to
 * U+FFFD, which is neither a prefix of the text nor within the cap.
 */
export function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // A continuation byte (10xxxxxx) at the cut means the character straddles it.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}
/**
 * Room for what an apply says about itself, which is a line per file and so
 * grows with the diff rather than being bounded by it. Node kills a child that
 * overruns its buffer, and killing `git apply` partway through leaves a tree
 * half-written — the one outcome this operation promises cannot happen. Sized
 * well past any diff the input cap admits, because the cost of slack here is
 * memory and the cost of shortfall is a corrupted working copy.
 */
export const APPLY_OUTPUT_CAP_BYTES = 16 * 1024 * 1024;

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
      | 'stale_base'
      | 'push_target_differs'
      | 'fetch_failed'
      | 'unresolved_conflict'
      | 'binary_conflict',
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
 * Objects read as they are stored, never as `refs/replace/*` substitutes them.
 * A push sends the stored objects, so a replacement would have the scan, the
 * measure of the push range and the review read one commit while `origin`
 * receives another. In the environment rather than as `--no-replace-objects`
 * so it reaches the git a coding agent runs in its checkout too.
 */
export const NO_REPLACE_OBJECTS_ENV = { GIT_NO_REPLACE_OBJECTS: '1' } as const;

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
    ...NO_REPLACE_OBJECTS_ENV,
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

/** What `git --version` on the executor's own PATH says, or nothing when git is absent. */
export async function gitVersionText(timeoutMs: number): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['--version'], { timeout: timeoutMs, env: gitEnv() });
    return stdout;
  } catch {
    return undefined;
  }
}

export async function git(
  cwd: string,
  args: string[],
  maxBuffer = 1024 * 1024,
  env: Record<string, string> = {},
): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...GIT_SAFETY_ARGS, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...gitEnv(), ...env },
  });
  return stdout;
}

/**
 * Bytes cut into lines, each held to at most `maxLineBytes` while it is read:
 * the rest of a longer line is counted and dropped, never buffered. Each line
 * is handed over with its whole length in bytes, so a line longer than what
 * was handed over says so.
 */
export class LineCutter {
  private parts: Buffer[] = [];
  private held = 0;
  private bytes = 0;
  private pending = false;

  constructor(
    private readonly maxLineBytes: number,
    private readonly onLine: (line: string, bytes: number) => void,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    while (start <= chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      this.hold(chunk.subarray(start, end));
      if (newline === -1) return;
      this.emit();
      start = newline + 1;
    }
  }

  /** Hand over a last line that no newline ended. */
  end(): void {
    if (this.pending) this.emit();
  }

  private hold(segment: Buffer): void {
    if (segment.length === 0) return;
    this.pending = true;
    this.bytes += segment.length;
    const room = this.maxLineBytes - this.held;
    if (segment.length > room) {
      if (room > 0) this.parts.push(segment.subarray(0, room));
      this.held = this.maxLineBytes;
      return;
    }
    this.parts.push(segment);
    this.held += segment.length;
  }

  private emit(): void {
    let line = Buffer.concat(this.parts).toString('utf8');
    let bytes = this.bytes;
    if (bytes <= this.maxLineBytes && line.endsWith('\r')) {
      line = line.slice(0, -1);
      bytes -= 1;
    }
    this.parts = [];
    this.held = 0;
    this.bytes = 0;
    this.pending = false;
    this.onLine(line, bytes);
  }
}

/**
 * What git prints for `args`, handed over a line at a time and never held
 * whole: for output whose size belongs to the repository rather than to this
 * lane, such as every commit of a range. A line past `maxLineBytes` is handed
 * over cut to that length, with its whole length beside it. Past `maxBytes` or `timeoutMs` git is
 * killed and the read refused, so a caller never mistakes part of the output
 * for all of it.
 */
export async function forEachGitLine(
  cwd: string,
  args: readonly string[],
  limits: {
    readonly maxBytes: number;
    readonly maxLineBytes: number;
    readonly timeoutMs: number;
  },
  onLine: (line: string, bytes: number) => void,
): Promise<void> {
  const lines = new LineCutter(limits.maxLineBytes, onLine);
  await forEachGitChunk(cwd, args, limits, (chunk) => {
    lines.push(chunk);
  });
  lines.end();
}

/**
 * What git prints for `args`, handed over in the chunks it arrives in, with
 * `stdin` written to it first: for output that is not lines, such as
 * `cat-file --batch`. The same limits and refusals as `forEachGitLine`.
 */
export async function forEachGitChunk(
  cwd: string,
  args: readonly string[],
  limits: { readonly maxBytes: number; readonly timeoutMs: number },
  onChunk: (chunk: Buffer) => void,
  stdin?: string,
): Promise<void> {
  const child = spawn('git', ['-C', cwd, ...GIT_SAFETY_ARGS, ...args], {
    env: gitEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // git may exit before reading all of it; its exit status says why.
  child.stdin.on('error', () => undefined);
  child.stdin.end(stdin ?? '');
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 4096) stderr += chunk;
  });
  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', resolveExit);
  });
  // Awaited after the read; this only keeps a spawn failure from reading as unhandled meanwhile.
  exited.catch(() => undefined);

  let refusal: string | undefined;
  const timer = setTimeout(() => {
    refusal = `git did not finish within ${String(limits.timeoutMs / 1000)} seconds.`;
    child.kill('SIGKILL');
  }, limits.timeoutMs);
  let readBytes = 0;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      readBytes += chunk.length;
      if (readBytes > limits.maxBytes) {
        refusal = `git printed more than ${String(limits.maxBytes / (1024 * 1024))} MB.`;
        child.kill('SIGKILL');
        break;
      }
      onChunk(chunk);
    }
    const code = await exited;
    if (refusal !== undefined) throw new WorktreeError(refusal, 'git_failed');
    if (code !== 0) {
      throw new WorktreeError(stderr.split('\n')[0] || `git exited ${String(code)}`, 'git_failed');
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

/** How many commits `<base>..<head>` holds. */
export async function countCommits(root: string, base: string, head: string): Promise<number> {
  return Number((await git(root, ['rev-list', '--count', `${base}..${head}`])).trim());
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
 * So an entry that resolves to a path the repository itself carries — under
 * its root and outside any installation — is a workspace package, mirrored as
 * the relative link the package manager wrote, from the mirrored entry to the
 * same path: it resolves inside the checkout, where the committed version is,
 * from wherever the checkout is reached. An entry that resolves anywhere else —
 * a real dependency, or a link landing within an installation — is pointed at
 * the operator's, which is the tree this lane will not duplicate.
 */
async function mirrorTarget(
  entryPath: string,
  mirroredPath: string,
  context: MirrorContext,
): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(entryPath);
  } catch {
    return entryPath;
  }
  if (!resolved.startsWith(context.rootReal + sep)) return entryPath;
  const inside = resolved.slice(context.rootReal.length + 1);
  if (inside.split(sep).includes(DEPENDENCY_DIR)) return entryPath;
  return relativePath(dirname(mirroredPath), join(context.worktreePath, inside));
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
    await symlink(await mirrorTarget(from, to, context), to).catch(() => {});
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

/**
 * The folder's repository directory, shared by every worktree added to it, with
 * symbolic links resolved — the one path that names this repository whichever
 * of its checkouts a git runs in.
 */
export async function commonGitDir(root: string): Promise<string> {
  const reported = (await git(root, ['rev-parse', '--git-common-dir'])).trim();
  return await realpath(isAbsolute(reported) ? reported : join(root, reported));
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

// How the operator's git reaches a remote, and proves who it is there, outside their
// config: ssh agent and command, proxy (curl reads `http_proxy` only in lower case, so
// both spellings travel), CA bundle, a global config outside `~`, and credentials.
const TRANSPORT_ENV = [
  'SSH_AUTH_SOCK',
  'GIT_SSH_COMMAND',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'GIT_SSL_CAINFO',
  'XDG_CONFIG_HOME',
  'GH_TOKEN', // what the `gh` credential helper their config names answers with
  'GITHUB_TOKEN',
  'GIT_ASKPASS', // how git and ssh ask for a password or passphrase with no terminal
  'SSH_ASKPASS',
  'DISPLAY', // where a graphical askpass opens
] as const;

/**
 * The environment a fetch or a push reaches a remote with: the operator's transport.
 *
 * Their credential helper, `sshCommand` and `insteadOf` rewrites live in the
 * system and global config, and their keys in the ssh agent, so a fetch without
 * them fails on every private remote. Reading that config here does not reopen
 * what `gitEnv` closes: a fetch checks nothing out and stages nothing, so no
 * filter runs, and the hooks stay off through `GIT_SAFETY_ARGS`.
 */
export function transportEnv(): Record<string, string> {
  const env = gitEnv('read');
  delete env['GIT_CONFIG_NOSYSTEM'];
  for (const name of TRANSPORT_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Whether `ref` is a ref name git would store, rather than a refspec. */
export async function isPlainRefName(root: string, ref: string): Promise<boolean> {
  // A leading `+` forces and a `:` names a destination: either would turn the
  // fetch into a write to one of the operator's branches.
  if (ref.startsWith('+')) return false;
  try {
    await git(root, ['check-ref-format', '--allow-onelevel', ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bring a base of the form `<remote>/<ref>` up to date before it is read.
 *
 * A remote-tracking ref says where the remote was at the folder's last fetch,
 * which may be long ago; a commission asked to start from `origin/main` means
 * the remote's `main` as it is now. A prefix that names none of the folder's
 * remotes is left alone, so a local branch with a slash in its name is read as
 * it is.
 */
export async function fetchRemoteBase(root: string, base: string): Promise<void> {
  // Longest first: remote names may themselves contain a slash.
  const remote = (await remoteNames(root))
    .filter((name) => base.startsWith(`${name}/`) && base.length > name.length + 1)
    .sort((a, b) => b.length - a.length)[0];
  if (remote === undefined) return;
  const ref = base.slice(remote.length + 1);
  if (!(await isPlainRefName(root, ref))) return;
  await fetchFromRemote(root, remote, ref);
}

/** The folder's remotes by name, or none where git cannot list them. */
export async function remoteNames(root: string): Promise<string[]> {
  try {
    return (await git(root, ['remote']))
      .split('\n')
      .map((name) => name.trim())
      .filter((name) => name !== '');
  } catch {
    return [];
  }
}

/** `git fetch <remote> <ref>`, refused with git's own reason when it fails. */
export async function fetchFromRemote(
  root: string,
  remote: string,
  ref: string,
  otherwise = 'name a local branch, tag or commit',
): Promise<void> {
  const base = `${remote}/${ref}`;
  try {
    await run('git', ['-C', root, ...GIT_SAFETY_ARGS, 'fetch', '--end-of-options', remote, ref], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: transportEnv(),
    });
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : '';
    const reason =
      stderr
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line !== '') ??
      (error instanceof Error && 'killed' in error && error.killed === true
        ? `no answer within ${String(GIT_TIMEOUT_MS / 1000)} seconds`
        : 'git fetch failed');
    throw new WorktreeError(
      `\`${base}\` names the remote \`${remote}\`, and \`${ref}\` could not be fetched from it: ` +
        `${reason}. The folder must reach \`${remote}\` the way the operator's own git does; ` +
        `otherwise ${otherwise}.`,
      'fetch_failed',
    );
  }
}

/**
 * The URL a fetch from `remote` reaches, as the operator's own git resolves it:
 * their `insteadOf` rewrites live in the config `transportEnv` reads.
 */
export async function remoteFetchUrl(root: string, remote: string): Promise<string> {
  const { stdout } = await run(
    'git',
    ['-C', root, ...GIT_SAFETY_ARGS, 'remote', 'get-url', remote],
    { timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024, env: transportEnv() },
  );
  return stdout.trim();
}

/**
 * Every URL a push to `remote` reaches, as the operator's own git resolves it:
 * `pushurl` where one is set, each `url` otherwise, after their
 * `pushInsteadOf` rewrites. A push goes to all of them.
 */
export async function remotePushUrls(root: string, remote: string): Promise<string[]> {
  const { stdout } = await run(
    'git',
    ['-C', root, ...GIT_SAFETY_ARGS, 'remote', 'get-url', '--push', '--all', remote],
    { timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024, env: transportEnv() },
  );
  return stdout
    .split('\n')
    .map((url) => url.trim())
    .filter((url) => url !== '');
}

/** Whether `ancestor` is `descendant` or a commit under it. */
export async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    // 1 is git's "no"; any other status is git failing to answer.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
      return false;
    }
    throw error;
  }
}

/** Where git keeps `name` for the repository at `root`, such as FETCH_HEAD. */
export async function gitPath(root: string, name: string): Promise<string> {
  return resolvePath(root, (await git(root, ['rev-parse', '--git-path', name])).trim());
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
  /**
   * The whole unified diff against `baseSha`, never a prefix. Empty when the
   * harness changed nothing, or when the diff is over `DIFF_CEILING_BYTES`.
   */
  readonly patch: string;
  readonly filesChanged: number;
  /** True when files changed but the diff is over the ceiling and was not read. */
  readonly overCeiling: boolean;
}

/**
 * The directory in a run's checkout that holds the run's own files — the result
 * a task asks for, and whatever else the agent keeps beside its work. It is
 * never part of the change.
 */
export const RUN_SCRATCH_DIR = '.aflow';

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
  await writeFile(
    excludes,
    [...mirrors, `${RUN_SCRATCH_DIR}/`].map((relative) => `/${relative}\n`).join(''),
    'utf8',
  );
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
  // The ignore rule keeps an untracked scratch file out of the index, but a
  // repository that tracks something under the directory still has its edits
  // staged, so the diff leaves the directory out by pathspec as well.
  const pathspec = ['--', '.', `:(exclude,top)${RUN_SCRATCH_DIR}`];
  const nameOnly = await git(worktreePath, ['diff', '--cached', '--name-only', ...pathspec]);
  const filesChanged = nameOnly.split('\n').filter((line) => line.length > 0).length;
  if (filesChanged === 0) {
    return { patch: '', filesChanged: 0, overCeiling: false };
  }

  try {
    // `--no-textconv` and `--no-ext-diff`: a harness can write `.gitattributes`,
    // and both a textconv driver and an external diff command are programs the
    // operator's own git config names and git runs here — outside the sandbox
    // the harness was confined to. The diff is wanted verbatim in any case.
    const patch = await git(
      worktreePath,
      ['diff', '--cached', '--no-textconv', '--no-ext-diff', ...pathspec],
      DIFF_CEILING_BYTES,
    );
    return { patch, filesChanged, overCeiling: false };
  } catch (error) {
    // The file list still stands, so an oversized diff is reported as what
    // changed without the body rather than as a failure to read.
    if ((error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { patch: '', filesChanged, overCeiling: true };
    }
    throw new WorktreeError(
      `Could not read what the harness changed: ${error instanceof Error ? error.message.split('\n')[0] : 'git failed'}`,
      'git_failed',
    );
  }
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

export interface LinkedWorktree {
  readonly path: string;
  /** No branch is checked out in it, which is how every checkout this lane makes is added. */
  readonly detached: boolean;
}

/**
 * Every checkout added to the repository, without its main one.
 *
 * Read from git rather than from disk: a checkout whose directory is gone is
 * still registered, and the registration is what the operator sees.
 */
export async function linkedWorktrees(root: string): Promise<LinkedWorktree[]> {
  const listing = await git(root, ['worktree', 'list', '--porcelain'], APPLY_OUTPUT_CAP_BYTES);
  return listing
    .split(/\n\n+/)
    .map((block) => block.split('\n'))
    .filter((lines) => lines[0]?.startsWith('worktree ') === true)
    .map((lines) => ({
      path: (lines[0] ?? '').slice('worktree '.length),
      detached: lines.includes('detached'),
    }))
    .slice(1);
}

/**
 * Whether the diff still fits the repository it came from.
 *
 * A run's result is a patch against the commit it started from, and by the time
 * anyone looks at it the operator may have committed, pulled or edited the same
 * lines. Saying so is the difference between a diff that can be taken and one
 * that needs a decision, and the answer has to come from git rather than from
 * comparing shas — a moved HEAD that touched other files still applies.
 *
 * With `against`, the diff is judged against that commit's tree rather than the
 * folder's working tree, through an index of its own, so the folder's index and
 * files are never a party to it.
 */
export type ApplyCheck =
  | { readonly state: 'clean' }
  | { readonly state: 'conflict'; readonly detail: string }
  | { readonly state: 'empty' };

export async function checkApplies(
  root: string,
  patch: string,
  against?: string,
): Promise<ApplyCheck> {
  if (patch === '') return { state: 'empty' };

  const scratch = await mkdtemp(join(tmpdir(), 'aflow-apply-'));
  const patchPath = join(scratch, 'run.patch');
  try {
    await writeFile(patchPath, patch, 'utf8');
    if (against === undefined) {
      await git(root, ['apply', '--check', patchPath]);
    } else {
      const index = { GIT_INDEX_FILE: join(scratch, 'index') };
      await git(root, ['read-tree', against], undefined, index);
      await git(root, ['apply', '--cached', '--check', patchPath], undefined, index);
    }
    return { state: 'clean' };
  } catch (error) {
    // git names the file and hunk it could not place, which is the whole of
    // what makes a conflict resolvable.
    const message = error instanceof Error ? error.message : String(error);
    const detail =
      message
        .split('\n')
        .filter((line) => line.startsWith('error:'))
        .join('; ') ||
      (against === undefined
        ? 'The patch does not apply to the repository as it stands.'
        : `The patch does not apply to ${against}.`);
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
 * The repository's local branches and tags, read before and after a run.
 *
 * Read from the connected folder, the listing holds the refs a worktree shares
 * with it and not the run's own detached HEAD. A difference between two
 * readings says a ref changed while the run was in flight, not who changed it:
 * the operator's own work in the folder moves them too. What stops the agent's
 * git is the hook in `refGuard.ts`; this is what the result reports.
 */
export async function snapshotRefs(root: string): Promise<RefSnapshot> {
  // A remote-tracking ref changes when a fetch runs — an editor's or a
  // background one — and moves nothing the operator wrote; `refs/stash` is the
  // operator's scratch.
  const listing = await git(
    root,
    ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/', 'refs/tags/'],
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
  | { readonly ref: string; readonly change: 'created'; readonly to: string }
  | { readonly ref: string; readonly change: 'deleted'; readonly from: string }
  | {
      readonly ref: string;
      readonly change: 'moved';
      readonly from: string;
      readonly to: string;
    };

export function changedRefs(before: RefSnapshot, after: RefSnapshot): RefChange[] {
  const changes: RefChange[] = [];
  for (const [ref, was] of before) {
    const now = after.get(ref);
    if (now === undefined) changes.push({ ref, change: 'deleted', from: was });
    else if (now !== was) changes.push({ ref, change: 'moved', from: was, to: now });
  }
  for (const [ref, now] of after) {
    if (!before.has(ref)) changes.push({ ref, change: 'created', to: now });
  }
  return changes.sort((a, b) => a.ref.localeCompare(b.ref));
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

    const numstat = await git(root, ['apply', '--numstat', '-z', patchPath], DIFF_CEILING_BYTES);
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
    const summary = await git(root, ['apply', '--summary', patchPath], DIFF_CEILING_BYTES);
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
const IDENTITY_KEYS = ['user.name', 'user.email'] as const;

function namedKeys(keys: readonly string[]): string {
  return keys.map((key) => `\`${key}\``).join(' and ');
}

/** The refusal of a commit no identity resolves for, given the keys it lacks as named code. */
export function noIdentityMessage(keys = namedKeys(IDENTITY_KEYS)): string {
  return (
    `Neither this repository nor the global git config sets ${keys}, so a commit made here ` +
    `would carry no identity. Set ${keys} in the repository, or globally, then run this again.`
  );
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

/**
 * The `-c` arguments a commit made here carries its identity in. The identity
 * is passed in, and `user.useConfigOnly` keeps git's own fallback off: a name
 * and address built from the account and the hostname would land in the
 * operator's history as an author they never chose. Where a key resolves from
 * neither config, `refuse` words the refusal around the keys missing.
 */
export async function commitIdentityArgs(
  cwd: string,
  refuse: (keys: string) => string = noIdentityMessage,
): Promise<string[]> {
  const resolve = async (key: string): Promise<string | undefined> =>
    (await configuredValue(cwd, ['--get', key], 'withheld')) ??
    (await configuredValue(cwd, ['--global', '--get', key], 'read'));
  const name = await resolve('user.name');
  const email = await resolve('user.email');
  if (name === undefined || email === undefined) {
    const missing = IDENTITY_KEYS.filter((key) =>
      key === 'user.name' ? name === undefined : email === undefined,
    );
    throw new WorktreeError(refuse(namedKeys(missing)), 'no_identity');
  }
  return ['-c', 'user.useConfigOnly=true', '-c', `user.name=${name}`, '-c', `user.email=${email}`];
}

/**
 * The commit a sha names, or nothing. git reads a short hex string as a ref
 * name before it reads it as a sha, and peels a tag's sha to the commit it
 * tags: only a commit whose own sha begins with this one is the commit it names.
 */
export async function commitNamedBySha(root: string, sha: string): Promise<string | undefined> {
  const commit = await resolveCommit(root, sha).catch(() => undefined);
  return commit?.startsWith(sha.toLowerCase()) === true ? commit : undefined;
}
