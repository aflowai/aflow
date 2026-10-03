/**
 * Compiling a binding into a sandbox policy.
 *
 * The shape is forced by what the adapter can express, which Phase 0 measured:
 * reads are permitted by default and narrowed by denial, so there is no
 * allow-list to write. Home is denied as a region and re-allowed selectively,
 * which is what actually protects a laptop — keys, cloud credentials, browser
 * profiles and this executor's own pairing state all live under it. Paths
 * outside home stay readable, and the operator is told so; what keeps their
 * contents on the machine is the egress policy, not the read policy.
 *
 * Four adapter options void the contract, so nothing here can set them:
 * `allowAppleEvents` removes code-execution isolation, `enableWeakerNetworkIsolation`
 * opens an exfiltration path through the trust daemon, `enableWeakerNestedSandbox`
 * exists to make the sandbox work inside Docker and materially weakens it, and
 * allowing a Unix socket hands over whatever listens on it — all-or-nothing on
 * Linux, so permitting the SSH agent would also expose the Docker socket. A test
 * asserts every compiled policy is free of them rather than trusting this comment.
 *
 * `allowLocalBinding` hands over whatever listens on loopback the same way, so
 * only the `open` posture sets it, and never alone. The machine's loopback
 * holds the stack's own services — its Redis, which takes no password and holds
 * run state and the write-approval grants the push gate reads, its database,
 * its API and its web application — and code a coding agent wrote that reaches
 * Redis can mint the grant that clears its own push. So under both postures the
 * policy denies each of their ports by name (`stackServices.ts`), and under
 * `open` the launcher refuses those ports on every address this machine answers
 * on and, on macOS, where loopback is reached without the proxy, in the profile
 * itself. Every other loopback port stays admitted, so a test that serves
 * itself still works. What keeps the machine's trust configuration and the
 * operator's own files from a job is the filesystem policy, the same under both.
 *
 * That includes the system's `/tmp`, which neither posture lets a job write. On
 * Linux every job's scratch lives there — its checkout, the policy and status
 * files the sandbox reads for it — so a job able to write `/tmp` could write
 * into another's, a `confined` folder's among them. A job writes the temporary
 * directory it is handed instead, inside its own scratch (`baseEnv.ts`).
 *
 * Under `confined`, loopback is the sandbox's own or nothing. On Linux the adapter
 * gives every process a network namespace of its own: a command binds, accepts
 * and connects on a loopback that holds only its own listeners, and the
 * machine's — the stack's Redis, which takes no password and holds run state
 * and write-approval grants, its Postgres, its API — are not there to reach. On
 * macOS there is no such namespace. Bind and accept are local, but the
 * profile's only loopback grant also admits a connection to every localhost
 * port, and a sandbox profile can name one port or all of them, never the
 * command's own. So on macOS a confined command cannot listen on loopback at
 * all, and a test that serves itself there fails under the sandbox.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { HostSandboxPosture } from '@aflow/schemas';

import type { HostBinding } from './bindings.js';
import { resolveHostDir } from './hostDir.js';
import { type StackService, stackServiceDenials, stackServicesOf } from './stackServices.js';

/** Only the fields this compiler sets. The adapter's own schema validates the rest. */
export interface CompiledSandboxPolicy {
  network: { allowedDomains: string[]; deniedDomains: string[]; allowLocalBinding?: true };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
}

/** Options that void the enforcement contract and are never emitted. */
export const FORBIDDEN_SANDBOX_OPTIONS = [
  'allowAppleEvents',
  'enableWeakerNetworkIsolation',
  'enableWeakerNestedSandbox',
  'allowUnixSockets',
] as const;

/** Set only under `open`, whose loopback is the machine's but for the stack's own services. */
export const OPEN_ONLY_SANDBOX_OPTION = 'allowLocalBinding';

function atOrUnder(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Interpreter and toolchain installations under the denied home region.
 *
 * Withholding these breaks every version-managed interpreter in turn, which is
 * the failure that makes people switch the sandbox off. So they are carved out
 * — but only the ones that are genuinely an installation.
 *
 * The list used to also carry `.cache`, `.npm` and `.gitconfig`, on the stated
 * reasoning that they "hold caches and version managers, not secrets". That was
 * wrong, and wrong in the direction that matters: `~/.cache/huggingface/token`,
 * `~/.cargo/credentials.toml` and a `~/.gitconfig` carrying a credential helper
 * all sit inside them. A command could read one and copy it into its own
 * binding, and closed egress does not help when the operator's folder is the
 * way out.
 *
 * What remains is toolchain trees. `.cargo` stays because cargo cannot build
 * without it, with its credential file denied by name — the one place here that
 * is a known-holes list rather than a boundary, and said plainly rather than
 * dressed up. Anything else an operator needs is theirs to declare through
 * `toolPaths`, which exists now and did not when this list was written.
 */
export function toolchainReadPaths(home: string): string[] {
  return [join(home, '.nvm'), join(home, '.pyenv'), join(home, '.rustup'), join(home, '.cargo')];
}

/**
 * Credential files inside the carve-outs above. Denied by name, which beats an
 * allow-list only because the alternative is refusing to run cargo at all.
 */
function credentialFilesInToolchains(home: string): string[] {
  return [join(home, '.cargo', 'credentials.toml'), join(home, '.cargo', 'credentials')];
}

/**
 * What a harness or a local server is additionally allowed, taken verbatim from
 * the machine's own profile. It arrives as a parameter rather than being read
 * here so the widening has exactly one source: a file the appliance cannot
 * write.
 */
export interface SandboxWidening {
  /** Read paths under the denied home region — the workload's own credential. */
  readonly authPaths: readonly string[];
  /** Paths outside the worktree it must write to function. */
  readonly writePaths?: readonly string[];
  /** Hosts it may reach. */
  readonly allowedDomains: readonly string[];
  /**
   * A writable root that is not the binding's, so a harness can edit an
   * isolated worktree while the connected folder stays untouched.
   */
  readonly writableRoot?: string;
  /**
   * Withhold the binding's own write grant even when it has one. A coding
   * harness works in its worktree and never needs the connected folder, so a
   * repository connected as writable — which git requires, to record the
   * worktree — does not thereby become writable by the harness.
   */
  readonly withholdBindingWrite?: boolean;
}

/**
 * Repository metadata anywhere beneath a root, not only at its top.
 *
 * `resolveWithin` refuses a `.git` segment at any depth; the compiled policy
 * denied only the root's own. A checkout containing a second repository —
 * a vendored dependency, a nested project, a submodule — therefore left
 * `sub/.git` readable and writable, which is a credential to read and a hook to
 * plant that git runs as the operator on the next checkout.
 *
 * The glob is honoured by the adapter, verified rather than assumed: with it,
 * `sub/.git/config` is refused and ordinary files under the same root are not.
 */
/**
 * The executable surfaces inside `.git`, which are what actually escalate.
 *
 * `hooks/` holds programs git runs as the operator, unconfined, on the next
 * checkout — and it needs neither reading nor writing for git to work: with the
 * directory unreadable, `log`, `status` and `commit` all still run. `config` is
 * where a `filter.*.smudge` or a textconv driver is *defined*, so writing there
 * chooses a program too — but reading it is not optional. Git aborts outright
 * on an unreadable config, which is what made the whole of `.git` a deny and
 * git itself unusable in a connected repository.
 */
function repositoryExecutableSurfaces(root: string): string[] {
  return [join(root, '.git', 'hooks'), join(root, '**', '.git', 'hooks')];
}

function repositoryConfigUnder(root: string): string[] {
  return [join(root, '.git', 'config'), join(root, '**', '.git', 'config')];
}

export function compileSandboxPolicy(
  binding: HostBinding,
  options: {
    home?: string;
    scratchDir: string;
    widening?: SandboxWidening;
    /** Where the machine says the operator's tools live. Read-only. */
    toolPaths?: readonly string[];
    /** What the folder runs under. A command no folder posture governs is `confined`. */
    posture?: HostSandboxPosture;
    /** The machine's host directory; resolved as the executor resolves it when absent. */
    hostDir?: string;
    /** The stack's own services; read from what the lane holds when absent. */
    stackServices?: readonly StackService[];
  } = { scratchDir: '' },
): CompiledSandboxPolicy {
  const home = options.home ?? homedir();
  const hostDir = options.hostDir ?? resolveHostDir(process.env, home);
  const open = options.posture === 'open';
  const scratch = options.scratchDir ? [options.scratchDir] : [];
  const widening = options.widening;
  const writableRoot = widening?.writableRoot ? [widening.writableRoot] : [];
  // The host directory holds the policy every gate reads — push approval, the
  // checks, the posture itself — and pairing's credential. Nothing a job is
  // granted reaches into it, under either posture, whatever a profile or the
  // machine's tool paths name.
  const outsideHostDir = (paths: readonly string[]): string[] =>
    paths.filter((path) => !atOrUnder(path, hostDir));
  const bindingWritable = binding.mode === 'readwrite' && widening?.withholdBindingWrite !== true;

  return {
    network: {
      // No egress until something declares one. A command that reaches the
      // network finds it closed rather than open-by-default. Under `open` the
      // launcher admits every host this list does not name, and every loopback
      // port but the stack's own services', which are denied here whatever a
      // profile allows.
      allowedDomains: [...(widening?.allowedDomains ?? [])],
      deniedDomains: stackServiceDenials(options.stackServices ?? stackServicesOf()),
      ...(open ? { [OPEN_ONLY_SANDBOX_OPTION]: true as const } : {}),
    },
    filesystem: {
      denyRead: [
        home,
        hostDir,
        ...credentialFilesInToolchains(home),
        ...repositoryExecutableSurfaces(binding.root),
        ...writableRoot.flatMap((r) => repositoryExecutableSurfaces(r)),
      ],
      allowRead: outsideHostDir([
        binding.root,
        ...scratch,
        ...writableRoot,
        ...toolchainReadPaths(home),
        ...(options.toolPaths ?? []),
        ...(widening?.authPaths ?? []),
        ...(widening?.writePaths ?? []),
      ]),
      allowWrite: outsideHostDir([
        ...(bindingWritable ? [binding.root] : []),
        ...scratch,
        ...writableRoot,
        ...(widening?.writePaths ?? []),
      ]),
      // Writing here is the escalation, and it is the only part that is.
      //
      // Git runs `hooks/` and a `filter.*.smudge` defined in `config` as the
      // operator, unconfined, on the next checkout — which every coding run
      // performs. A command able to write either chooses what runs outside this
      // boundary, so both stay closed for writing whatever the binding allows.
      //
      // Reading `.git` is open, and that is a change of position. It was closed
      // on the reasoning that `config` can hold a remote URL with a token in it.
      // True — and it does not survive the company it keeps: this binding grants
      // read of the whole folder, `.env` files included, so singling out one
      // file for disclosure while the rest of the operator's secrets are
      // readable draws no line anybody can defend. What it did instead was make
      // git unusable in a connected repository — `log`, `status` and `diff` all
      // abort, because git will not start without reading its config — which is
      // most of why an operator connects a repository at all.
      //
      // So: disclosure inside a folder the operator connected is theirs to
      // allow, and escalation out of it is not.
      denyWrite: [
        hostDir,
        ...repositoryExecutableSurfaces(binding.root),
        ...writableRoot.flatMap((r) => repositoryExecutableSurfaces(r)),
        ...repositoryConfigUnder(binding.root),
        ...writableRoot.flatMap((r) => repositoryConfigUnder(r)),
      ],
    },
  };
}
