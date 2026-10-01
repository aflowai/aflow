/**
 * Host bindings and the path confinement around them.
 *
 * A binding is the operator's statement about one machine: this root, this
 * mode. It is read from the host's own policy file, which lives outside any
 * path a job can write, so a job cannot grant itself a root by editing the file
 * that lists them. Effective authority is the intersection of this file and the
 * grant that arrives with the job — the host's copy is a ceiling, never a
 * source of new authority.
 *
 * `resolveWithin` is the only way a path from a job becomes a path on disk.
 * It resolves symlinks before deciding, because the check that matters is where
 * a path *lands*, not how it reads: a symlink inside the root pointing at
 * `~/.ssh` looks relative and is not. The OS boundary refuses that too, and
 * this refuses it earlier and with a better error.
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve, sep } from 'node:path';

import { z } from 'zod';

import { HostBindingBranchPolicySchema } from '@aflow/schemas';

import { type HarnessProfile, HarnessProfileSchema } from './harnessProfiles.js';
import { type LocalMcpServer, LocalMcpServerSchema } from './localMcpServers.js';

export const HostBindingModeSchema = z.enum(['read', 'readwrite']);
export type HostBindingMode = z.infer<typeof HostBindingModeSchema>;

export const HostBindingSchema = z.object({
  id: z.string().min(1),
  root: z.string().min(1).describe('Absolute path on this machine.'),
  mode: HostBindingModeSchema,
  /**
   * Whether commands may run here at all, as opposed to files being read and
   * written. Default false, and deliberately separate from `mode`: a folder
   * connected for its contents should not become a shell by being connected,
   * and the larger grant should be the one that had to be typed.
   *
   * This is the machine's own ceiling. The appliance carries its own copy of
   * the same decision, and a job runs only where both allow it — so a
   * compromised appliance asking for a command in a folder the operator marked
   * read-only is refused here, by the file it cannot write.
   */
  allowsExecution: z.boolean().default(false),
  /**
   * Which branches a push from this folder may move, if any, and when a
   * publication asks the operator before pushing.
   *
   * A fact about the folder like `allowsExecution`, and absent by default: a
   * folder that allows commands is not thereby a folder whose history anything
   * may publish. Never forcing is a rule rather than a field — there is no
   * setting that turns it off.
   */
  branchPolicy: HostBindingBranchPolicySchema.optional(),
  /** Present for a binding the operator connected as a single file rather than a folder. */
  singleFile: z.boolean().default(false),
  /**
   * The workspace this folder was connected for.
   *
   * Without it, the only authority checked was the machine's: a binding id is
   * addressable by anything that can reach this executor, so a second workspace
   * on the same appliance could name another's binding and reach that folder,
   * and deleting the appliance-side row revoked nothing. The appliance cannot
   * be trusted to police that on its own — it is the half that can be
   * compromised — so the machine records who the folder was connected for and
   * checks it, the same way it records everything else about the grant.
   *
   * Absent means a policy written before this was recorded. Fail closed: a
   * binding that cannot say which workspace it belongs to belongs to none.
   */
  spaceId: z.string().min(1).optional(),
});
export type HostBinding = z.infer<typeof HostBindingSchema>;

export const HostPolicySchema = z.object({
  version: z.literal(1),
  bindings: z.array(HostBindingSchema),
  /** Coding harnesses this machine will run. Absent means none may run here. */
  harnesses: z.array(HarnessProfileSchema).default([]),
  /** MCP servers this machine will run. Absent means none may run here. */
  mcpServers: z.array(LocalMcpServerSchema).default([]),
  /**
   * Where the operator keeps tools they want commands to be able to run.
   *
   * Home is denied as a region, which protects keys, cloud credentials and
   * browser profiles — and also, incidentally, catches every CLI installed
   * under it. A harness and an MCP server each declare the paths they need;
   * a plain command had no way to say the same thing, so the only remedy was
   * reinstalling the program somewhere else. That is a workaround for a
   * missing declaration, not a security property: nothing is safer about a
   * binary in `/usr/local/bin` than the same binary in `~/.local/bin`.
   *
   * Read-only, machine-wide, and declared in the file the appliance cannot
   * write — the operator says once where their tools live.
   */
  toolPaths: z
    .array(z.string().min(1))
    .default([])
    .describe('Absolute paths a command may read, in addition to its binding.'),
});

export class HostBindingError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'unknown_binding'
      | 'outside_root'
      | 'read_only'
      | 'not_a_directory'
      | 'no_execution'
      | 'push_refused'
      | 'wrong_space'
      | 'policy',
  ) {
    super(message);
    this.name = 'HostBindingError';
  }
}

export interface LoadedHostPolicy {
  bindings: Map<string, HostBinding>;
  harnesses: Map<string, HarnessProfile>;
  mcpServers: Map<string, LocalMcpServer>;
  /** Extra read paths every command in this machine's bindings may use. */
  toolPaths: readonly string[];
}

export async function loadHostPolicy(policyPath: string): Promise<LoadedHostPolicy> {
  let raw: string;
  try {
    raw = await readFile(policyPath, 'utf8');
  } catch {
    throw new HostBindingError(
      `No host policy at ${policyPath}. Pair this machine before running host jobs.`,
      'policy',
    );
  }
  const parsed = HostPolicySchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new HostBindingError(`Host policy at ${policyPath} is not valid.`, 'policy');
  }
  return {
    bindings: new Map(parsed.data.bindings.map((b) => [b.id, b])),
    harnesses: new Map(parsed.data.harnesses.map((h) => [h.id, h])),
    mcpServers: new Map(parsed.data.mcpServers.map((m) => [m.id, m])),
    toolPaths: parsed.data.toolPaths,
  };
}

export function requireBinding(bindings: Map<string, HostBinding>, bindingId: string): HostBinding {
  const binding = bindings.get(bindingId);
  if (binding === undefined) {
    throw new HostBindingError(
      `This machine has no binding \`${bindingId}\`. The operator connects one before it can be used.`,
      'unknown_binding',
    );
  }
  return binding;
}

/**
 * A single-file binding is one file, not a root with one file in it. Listing it
 * is a category error rather than an empty result, and saying so is better than
 * a raw ENOTDIR.
 */
export function requireDirectory(binding: HostBinding): void {
  if (binding.singleFile) {
    throw new HostBindingError(
      `Binding \`${binding.id}\` is a single file, so there is nothing to list.`,
      'not_a_directory',
    );
  }
}

/**
 * The ceiling on running anything at all. Checked before a policy is compiled
 * or a process is spawned, because the cheapest refusal is the one that happens
 * before any of that exists.
 */
export function requireExecution(binding: HostBinding): void {
  if (!binding.allowsExecution) {
    throw new HostBindingError(
      `Binding \`${binding.id}\` does not allow commands. Its files can be read and written; ` +
        'running things there is a separate grant the operator makes on this machine.',
      'no_execution',
    );
  }
}

/** git's own options that consume the token after them, or carry it after `=`. */
const GIT_GLOBAL_OPTIONS_TAKING_A_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--exec-path',
  '--namespace',
  '--super-prefix',
  '--attr-source',
  '--config-env',
]);

const GIT_GLOBAL_FLAGS = new Set([
  '-p',
  '-P',
  '--paginate',
  '--no-pager',
  '--bare',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--icase-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--no-optional-locks',
  '--no-lazy-fetch',
  '--no-advice',
]);

const PUSH_OPTIONS_REFUSED = new Set([
  '-f',
  '--force',
  '--force-with-lease',
  '--force-if-includes',
  '-d',
  '--delete',
  '--mirror',
  '--all',
  '--tags',
  '--prune',
]);

const PUSH_OPTIONS_TAKING_A_VALUE = new Set(['-o', '--push-option']);

/** Push options naming a program to run or a repository other than this one. */
const PUSH_OPTIONS_NAMING_A_PROGRAM = new Set(['--receive-pack', '--exec', '--repo']);

/**
 * What every push carries, so the operator's `push.followTags` and
 * `push.recurseSubmodules` cannot add tags or submodule commits that no refspec
 * names. git reads the last of an option and its negation, which is why the
 * positive forms are refused outright rather than allowed before these.
 */
export const PUSH_REQUIRED_OPTIONS = ['--no-follow-tags', '--no-recurse-submodules'] as const;

const PUSH_OPTIONS_UNDOING_A_REQUIRED_ONE = new Set(['--follow-tags', '--recurse-submodules']);

/** The plain spelling every refusal points at. */
function plainPush(prefix: string): string {
  return `\`git push ${PUSH_REQUIRED_OPTIONS.join(' ')} <remote> ${prefix}<name>\``;
}

/**
 * Whether a long option is `option` as git would read it: whole, with a value,
 * or cut short — git takes any unambiguous prefix of a long option for it.
 */
function spellsOption(name: string, option: string): boolean {
  return name === option || (name.length > 2 && option.startsWith(name));
}

function spellsAnyOf(name: string, options: ReadonlySet<string>): string | undefined {
  for (const option of options) if (spellsOption(name, option)) return option;
  return undefined;
}

/** Enough of the command to recognise it in the refusal, and no more. */
const REFUSED_COMMAND_ECHO_LIMIT = 500;

interface GitInvocation {
  readonly subcommand: string | undefined;
  readonly rest: readonly string[];
  /** The first of git's own options standing before the subcommand, if any. */
  readonly globalOption: string | undefined;
  /** An option before the subcommand that this rule cannot account for. */
  readonly unreadable: boolean;
}

function longOptionName(token: string): string {
  const equals = token.indexOf('=');
  return equals === -1 ? token : token.slice(0, equals);
}

/**
 * Where git's own options end and the subcommand begins.
 *
 * Skipping the wrong number of tokens is how a rule reads `push` as the value
 * of the option before it and lets the command through, so an option this does
 * not know ends the scan and is reported rather than guessed at.
 */
function readGitInvocation(argv: readonly string[]): GitInvocation {
  let globalOption: string | undefined;
  let index = 1;
  while (index < argv.length) {
    const token = argv[index];
    if (token?.startsWith('-') !== true) break;
    const name = longOptionName(token);
    globalOption ??= name;
    if (GIT_GLOBAL_OPTIONS_TAKING_A_VALUE.has(name)) {
      index += token.includes('=') ? 1 : 2;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    return { subcommand: undefined, rest: argv.slice(index), globalOption, unreadable: true };
  }
  return {
    subcommand: argv[index],
    rest: argv.slice(index + 1),
    globalOption,
    unreadable: false,
  };
}

function isGitProgram(program: string): boolean {
  return program === 'git' || program.endsWith('/git');
}

function refusePush(argv: readonly string[], because: string, remedy: string): never {
  const echoed = argv.join(' ');
  throw new HostBindingError(
    `\`${echoed.length > REFUSED_COMMAND_ECHO_LIMIT ? `${echoed.slice(0, REFUSED_COMMAND_ECHO_LIMIT)}…` : echoed}\` ` +
      `was not run: ${because}. ${remedy}`,
    'push_refused',
  );
}

/**
 * Whether this argv is a git push.
 *
 * The one command that runs outside the sandbox, so the path that runs it and
 * the rule that vets it ask the same parser. Two parsers would eventually
 * disagree, and what a disagreement here produces is a command running
 * unconfined that the rule never read.
 */
export function isGitPush(argv: readonly string[]): boolean {
  const program = argv[0];
  if (program === undefined || !isGitProgram(program)) return false;
  const invocation = readGitInvocation(argv);
  return !invocation.unreadable && invocation.subcommand === 'push';
}

/** A push the rule permits: where it goes, its refspecs, and what each of them sends. */
export interface PermittedPush {
  readonly remote: string;
  readonly refspecs: readonly string[];
  readonly sources: readonly string[];
}

/** What the job asked for around the command, which a push also constrains. */
export interface PushJobShape {
  readonly env?: Record<string, string>;
  readonly detach?: boolean;
}

function refuseUnconfinedOption(argv: readonly string[], option: string, prefix: string): never {
  refusePush(
    argv,
    `\`${option}\` is not an option a push may carry: a push runs as the operator's own git, ` +
      'so it takes no option that names a program or another repository',
    `Spell the push plainly: ${plainPush(prefix)}.`,
  );
}

/**
 * Which branches a push may move, enforced on the machine that holds the
 * repository.
 *
 * A push is the one command whose effect leaves the folder, so it is the one
 * command read before it runs — everything else is judged by the boundary
 * alone, which cannot tell writing a file from rewriting a published branch.
 * The gate runs before anything is spawned, and everything that is not a push
 * returns untouched.
 *
 * The rule is stated as what it permits: a named branch under the prefix the
 * operator declared, moved forward, spelled `git push --no-follow-tags
 * --no-recurse-submodules <push options> <remote> <refspec…>`. Force,
 * deletion, mirroring, `--all`, `--tags`, `--follow-tags` and
 * `--recurse-submodules` are refused outright rather than checked against the
 * prefix, because each of them moves something no refspec on the command
 * names; the two `--no-` options are required because the operator's config
 * can turn the last two on for a push that spells neither. A long option is
 * read the way git reads it, cut short to any prefix that names it.
 *
 * What passes here then runs as the operator's own git rather than inside the
 * sandbox, which is why nothing stands before `push`, no push option names a
 * program or another repository, and the job supplies no environment: each of
 * those would be the job choosing what runs unconfined.
 *
 * Returns the remote a permitted push names, its refspecs and the source of
 * each, and nothing for any other command.
 */
export function requirePushAllowed(
  binding: HostBinding,
  argv: readonly string[],
  job: PushJobShape = {},
): PermittedPush | undefined {
  const program = argv[0];
  if (program === undefined || !isGitProgram(program)) return undefined;

  const invocation = readGitInvocation(argv);
  if (invocation.unreadable) {
    // A command this cannot parse is only refused where it might be a push:
    // `git commit -m push` is not one, and refusing it would be the rule
    // reaching past what it is for.
    if (!invocation.rest.includes('push')) return undefined;
    refusePush(
      argv,
      'an option before the subcommand leaves it unclear whether this is a push',
      `Spell the push plainly: \`git push ${PUSH_REQUIRED_OPTIONS.join(' ')} <remote> <branch>\`.`,
    );
  }
  if (invocation.subcommand !== 'push') return undefined;

  const prefix = binding.branchPolicy?.branchPrefix;
  if (prefix === undefined) {
    refusePush(
      argv,
      `binding \`${binding.id}\` declares no branch prefix, so nothing may be pushed from it`,
      'Reconnect the folder with `--branch-prefix <prefix>` to allow pushes under one.',
    );
  }
  if (invocation.globalOption !== undefined) {
    refuseUnconfinedOption(argv, invocation.globalOption, prefix);
  }

  const supplied = Object.keys(job.env ?? {}).sort();
  if (supplied.length > 0) {
    refusePush(
      argv,
      "a push runs in the operator's own environment, so a job may not set " +
        supplied.map((name) => `\`${name}\``).join(', '),
      "Push with no environment of its own; the folder and the operator's git supply the rest.",
    );
  }
  if (job.detach === true) {
    refusePush(
      argv,
      'a push is waited for, so it cannot be detached',
      'Run it without `detach` and read what it reported.',
    );
  }

  const positional: string[] = [];
  const carried = new Set<string>();
  for (let index = 0; index < invocation.rest.length; index += 1) {
    const token = invocation.rest[index];
    if (token === undefined) continue;
    if (token === '--') {
      positional.push(...invocation.rest.slice(index + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }
    const name = longOptionName(token);
    const naming = spellsAnyOf(name, PUSH_OPTIONS_NAMING_A_PROGRAM);
    if (naming !== undefined) refuseUnconfinedOption(argv, naming, prefix);
    const moving = spellsAnyOf(name, PUSH_OPTIONS_REFUSED);
    if (moving !== undefined) {
      refusePush(
        argv,
        `\`${moving}\` moves a branch the command does not name, or moves one backwards`,
        `Push a named branch under \`${prefix}\` forward: ${plainPush(prefix)}.`,
      );
    }
    const undoing = spellsAnyOf(name, PUSH_OPTIONS_UNDOING_A_REQUIRED_ONE);
    if (undoing !== undefined) {
      refusePush(
        argv,
        `\`${undoing}\` sends what no refspec on the command names — tags pointing into the ` +
          'commits, or commits of submodules',
        `Push the named branch alone: ${plainPush(prefix)}.`,
      );
    }
    // A short cluster is one token carrying several options, so `-fu` is a
    // force too.
    const cluster = /^-[A-Za-z]+$/.test(token);
    if (cluster && (token.includes('f') || token.includes('d'))) {
      refusePush(
        argv,
        `\`${token}\` carries a force or a delete`,
        `Push a named branch under \`${prefix}\` forward: ${plainPush(prefix)}.`,
      );
    }
    if (PUSH_REQUIRED_OPTIONS.some((option) => option === token)) carried.add(token);
    // An option that takes a value and has none attached takes the next token
    // whole, whatever it looks like — a required option included.
    const takesNext = cluster
      ? token.indexOf('o') === token.length - 1
      : spellsAnyOf(name, PUSH_OPTIONS_TAKING_A_VALUE) !== undefined && !token.includes('=');
    if (takesNext) index += 1;
  }

  const missing = PUSH_REQUIRED_OPTIONS.filter((option) => !carried.has(option));
  if (missing.length > 0) {
    refusePush(
      argv,
      `it does not carry ${missing.map((option) => `\`${option}\``).join(' and ')}, so the ` +
        "operator's git config could add tags or submodule commits that no refspec names",
      `Spell both: ${plainPush(prefix)}.`,
    );
  }

  const [remote, ...refspecs] = positional;
  if (remote === undefined || refspecs.length === 0) {
    refusePush(
      argv,
      'a push with no refspec moves whatever the repository is configured to move, which this rule cannot see',
      `Name the branch: ${plainPush(prefix)}.`,
    );
  }
  const sources: string[] = [];
  for (const refspec of refspecs) {
    if (refspec.startsWith('+')) {
      refusePush(
        argv,
        `\`${refspec}\` is a forced refspec`,
        `Push it without the leading \`+\`, under \`${prefix}\`.`,
      );
    }
    const separator = refspec.indexOf(':');
    const source = separator === -1 ? refspec : refspec.slice(0, separator);
    const destination = separator === -1 ? refspec : refspec.slice(separator + 1);
    sources.push(source);
    if (separator !== -1 && source === '') {
      refusePush(
        argv,
        `\`${refspec}\` deletes the branch on the remote`,
        `Push a named branch under \`${prefix}\` forward instead.`,
      );
    }
    // A sha source needs its destination spelled in full, since git cannot infer
    // a ref namespace from a commit; any other namespace stays refused.
    const branch = destination.startsWith('refs/heads/')
      ? destination.slice('refs/heads/'.length)
      : destination;
    if (!branch.startsWith(prefix)) {
      refusePush(
        argv,
        `\`${destination}\` is not a branch binding \`${binding.id}\` may push`,
        `Push a branch under \`${prefix}\`, or reconnect the folder with a prefix that covers it.`,
      );
    }
  }
  return { remote, refspecs, sources };
}

export function requireWritable(binding: HostBinding): void {
  if (binding.mode !== 'readwrite') {
    throw new HostBindingError(
      `Binding \`${binding.id}\` is read-only. That is the binding, not the path.`,
      'read_only',
    );
  }
}

/** True when `candidate` is the root itself or sits beneath it. */
function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Turn a job-supplied relative path into an absolute one inside the binding,
 * or refuse. `mustExist` distinguishes reading from creating: a file being
 * written may not exist yet, so its *parent* is what has to resolve inside.
 */
/**
 * A repository's own `.git` is not ordinary content.
 *
 * `config` and `hooks/` are executable surfaces: git runs a `post-checkout`
 * hook and a `filter.*.smudge` command as the operator, outside any sandbox,
 * the next time anything checks the repository out — which this lane does on
 * every coding run. A job that could write there would be choosing what runs
 * unconfined. Reading is refused with it, because a remote URL in `config` can
 * carry a token.
 *
 * Judged on where a path *lands*, not on how it was spelled. A symlink named
 * anything at all can point at `.git`, and macOS — this lane's platform — folds
 * case, so `.GIT/config` and `.git/config` are the same file. Both were ways
 * through when this compared the requested text.
 *
 * The operator's own repository is trusted; what is refused is the appliance
 * gaining a way to change it.
 */
function assertOutsideRepositoryMetadata(
  binding: HostBinding,
  requested: string,
  root: string,
  resolvedPath: string,
): void {
  const relative = resolvedPath.slice(root.length).split(sep).filter(Boolean);
  if (!relative.some((segment) => segment.toLowerCase() === '.git')) return;
  throw new HostBindingError(
    `\`${requested}\` is inside a repository's \`.git\` directory, which binding \`${binding.id}\` does not reach. ` +
      'Git runs hooks and filters from there as you, outside the sandbox.',
    'outside_root',
  );
}

/**
 * The same judgement applied to the root itself.
 *
 * Everything above asks where a requested path lands relative to the root, and
 * so had nothing to say about a root that is already `.git` or sits inside one.
 * A binding on `/repo/.git` or on the single file `/repo/.git/config` passed
 * every check and reached exactly what the rule exists to protect — and the
 * single-file case skipped the check entirely, since there is no relative part
 * to examine. Judged on the canonical path, because a binding root can be a
 * symlink like any other path.
 */
export async function assertRootOutsideRepositoryMetadata(id: string, root: string): Promise<void> {
  const canonical = await realpath(root).catch(() => root);
  if (!canonical.split(sep).some((segment) => segment.toLowerCase() === '.git')) return;
  throw new HostBindingError(
    `\`${root}\` is inside a repository's \`.git\` directory, so it cannot be connected as ` +
      `\`${id}\`. Git runs hooks and filters from there as you, outside the sandbox.`,
    'outside_root',
  );
}

export async function resolveWithin(
  binding: HostBinding,
  requested: string,
  mustExist: boolean,
): Promise<string> {
  if (binding.singleFile && requested !== '.' && requested !== basename(binding.root)) {
    throw new HostBindingError(
      `Binding \`${binding.id}\` is the single file \`${basename(binding.root)}\`; ` +
        `\`${requested}\` is not it.`,
      'outside_root',
    );
  }
  if (binding.singleFile) {
    const resolved = await realpath(binding.root);
    await assertRootOutsideRepositoryMetadata(binding.id, resolved);
    return resolved;
  }

  if (isAbsolute(requested)) {
    throw new HostBindingError(
      `Paths are relative to the binding root; \`${requested}\` is absolute.`,
      'outside_root',
    );
  }

  const root = await realpath(binding.root);
  await assertRootOutsideRepositoryMetadata(binding.id, root);
  const target = resolve(root, requested);

  // Textual containment first, so an obvious `../` is refused before touching disk.
  if (!isWithin(root, target)) {
    throw new HostBindingError(
      `\`${requested}\` resolves outside binding \`${binding.id}\`.`,
      'outside_root',
    );
  }

  assertOutsideRepositoryMetadata(binding, requested, root, target);

  // Then where it actually lands, which is what a symlink changes.
  try {
    const real = await realpath(target);
    if (!isWithin(root, real)) {
      throw new HostBindingError(
        `\`${requested}\` leads outside binding \`${binding.id}\`.`,
        'outside_root',
      );
    }
    // Where it lands, now that symlinks and case folding have been applied.
    assertOutsideRepositoryMetadata(binding, requested, root, real);
    return real;
  } catch (error) {
    if (error instanceof HostBindingError) throw error;
    if (mustExist) {
      throw new HostBindingError(
        `\`${requested}\` does not exist in \`${binding.id}\`.`,
        'outside_root',
      );
    }
    // `realpath` failing does not mean the path is absent. A symlink whose
    // target does not exist resolves nowhere while the link itself is very much
    // there, and a write follows it — so the parent check below would pass, the
    // write would land wherever the link points, and a read/write folder
    // binding would become arbitrary write as the operator. Refuse a link as
    // the final component outright: nothing here needs to write through one,
    // and deciding where it *would* land is a race against whoever can replace
    // it between the check and the open.
    const link = await lstat(target).catch(() => null);
    if (link?.isSymbolicLink() === true) {
      throw new HostBindingError(
        `\`${requested}\` is a symlink, and writing through one leaves the binding.`,
        'outside_root',
      );
    }

    // Creating: some ancestor exists, and it is the deepest existing one whose
    // real location decides this. Checking only the immediate parent would
    // refuse `reports/out.md` in an empty binding — a directory the write is
    // entitled to create — while still missing nothing, since every segment
    // between it and the root is about to be created inside it.
    let ancestor = resolve(target, '..');
    let realAncestor = await realpath(ancestor).catch(() => null);
    while (realAncestor === null) {
      const next = resolve(ancestor, '..');
      if (next === ancestor) break;
      ancestor = next;
      realAncestor = await realpath(ancestor).catch(() => null);
    }
    if (realAncestor === null || !isWithin(root, realAncestor)) {
      throw new HostBindingError(
        `\`${requested}\` would be created outside binding \`${binding.id}\`.`,
        'outside_root',
      );
    }
    // A path being created under a resolved ancestor: judge the ancestor, since
    // that is the part symlinks and case folding have already been applied to.
    assertOutsideRepositoryMetadata(binding, requested, root, realAncestor);
    return target;
  }
}

/**
 * The workspace a job came from must be the one the folder was connected for.
 * Checked on the machine, because the appliance is the half that can be
 * compromised into asking for someone else's binding.
 */
export function requireSpace(binding: HostBinding, spaceId: string | undefined): void {
  if (binding.spaceId === undefined) {
    throw new HostBindingError(
      `Binding \`${binding.id}\` does not record which workspace it was connected for, so it ` +
        'reaches none. Reconnect the folder to record it.',
      'wrong_space',
    );
  }
  if (spaceId === undefined) {
    throw new HostBindingError(
      `This request names no workspace, so it cannot be the one \`${binding.id}\` was connected for.`,
      'wrong_space',
    );
  }
  if (binding.spaceId !== spaceId) {
    // Deliberately does not name the workspace it does belong to: that would
    // confirm which id is worth guessing next.
    throw new HostBindingError(
      `Binding \`${binding.id}\` was not connected for this workspace.`,
      'wrong_space',
    );
  }
}

/**
 * Bindings that still permit execution, as one definition.
 *
 * Reconciliation asks "is this binding still granted", and three of the four
 * places that asked it accepted any binding that still existed. Taking `--run`
 * away is a withdrawal too: it leaves the folder connected while revoking the
 * right to run anything in it, and a detached command kept both its execution
 * and its filesystem access until timeout. The fourth place had it right, which
 * is exactly how a rule drifts — so there is one of them now.
 */
export function executionPermitted(bindings: ReadonlyMap<string, HostBinding>): Set<string> {
  return new Set(
    [...bindings.values()]
      .filter((binding) => binding.allowsExecution)
      .map((binding) => binding.id),
  );
}
