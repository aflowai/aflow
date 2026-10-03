/**
 * The one place this executor spawns anything.
 *
 * Commands and coding harnesses differ in what they are asked to do and in how
 * much of the boundary they need open, and a permitted push differs further
 * still — it runs unconfined, as the operator's own git, as a coding agent and
 * a folder's checks do in a folder whose posture is `open`. None of them differ in
 * how they are supervised, captured or stopped, which is what `superviseSpawn`
 * holds: a second spawn path would mean the group-kill, the output cap and the
 * timeout each had two implementations, and a fix to one would silently miss the
 * other. A contract test asserts nothing else spawns.
 *
 * Sharing the registry is also what makes `host.process.inspect` and
 * `host.process.stop` work against a harness run: a run started by any
 * operation is a process this executor is holding, addressable by its id.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';

import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

import { buildBaseEnv, workloadHome } from './baseEnv.js';
import type { ExecutionPermitted, HostBinding } from './bindings.js';
import { createStreamScrubber } from './credentialFetch.js';
import { assertSafeEnv } from './envPolicy.js';
import { forgetSpawn, recordSpawn } from './orphans.js';
import { compileSandboxPolicy, type SandboxWidening } from './sandboxPolicy.js';
import { transportEnv } from './worktree.js';

/**
 * What a process runs under, and so what withdrawing ends it. A binding and a
 * browser profile are separate namespaces: no binding id, whatever it is
 * spelled, can keep a profile's browser alive, nor a profile a command.
 */
export type ProcessScope =
  | { readonly kind: 'binding'; readonly id: string }
  | { readonly kind: 'browser-profile'; readonly id: string };

/** Captured output is capped so one chatty build cannot become the step's payload. */
export const OUTPUT_CAP_BYTES = 256 * 1024;

/** How long a workload gets to end politely before it is ended for it. */
const SIGKILL_AFTER_MS = 5_000;

interface RunningProcess {
  readonly child: ChildProcess;
  readonly scope: ProcessScope;
  /**
   * The run that started it. Handles are addressed by id, and an id is
   * guessable, so ownership is what stops one run steering another's process.
   * Keyed on the run rather than the step execution, which names an attempt —
   * a retried step would otherwise disown the process it is retrying.
   */
  readonly ownerRunId: string;
  readonly startedAt: Date;
  exitCode: number | null;
  exited: boolean;
  exitedAt?: number;
  /** Output a detached process produced since anyone last read it. */
  buffered: string;
  /** True once the buffer stopped growing because it hit the cap. */
  bufferTruncated: boolean;
}

/** Handles live only in this executor, and only until it restarts. */
const running = new Map<string, RunningProcess>();

/**
 * How long a finished process stays answerable. Deleting it the moment it
 * exits makes `host.process.inspect` say `unknown` for every completed run,
 * which is the one answer that means "this executor cannot tell you" — so a run
 * that finished normally was indistinguishable from one lost to a restart.
 * Bounded rather than kept, so the map does not grow with every job.
 */
const EXITED_RETENTION_MS = 10 * 60 * 1000;

function pruneExited(now: number): void {
  for (const [id, entry] of running) {
    if (
      entry.exited &&
      entry.exitedAt !== undefined &&
      now - entry.exitedAt > EXITED_RETENTION_MS
    ) {
      running.delete(id);
    }
  }
}

let processCounter = 0;
function nextProcessId(prefix: string): string {
  processCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${String(processCounter)}`;
}

/** The registry entry every spawn path makes, so every reaping path finds it. */
function enterRegistry(
  child: ChildProcess,
  idPrefix: string,
  scope: ProcessScope,
  ownerRunId: string,
  startedAt: Date,
): { processId: string; entry: RunningProcess } {
  const processId = nextProcessId(idPrefix);
  const entry: RunningProcess = {
    child,
    scope,
    ownerRunId,
    startedAt,
    exitCode: null,
    exited: false,
    buffered: '',
    bufferTruncated: false,
  };
  running.set(processId, entry);
  return { processId, entry };
}

/** Whether the policy still grants what a process runs under, each kind against its own set. */
export function scopePermitted(scope: ProcessScope, permitted: ExecutionPermitted): boolean {
  return scope.kind === 'binding'
    ? permitted.bindings.has(scope.id)
    : permitted.browserProfiles.has(scope.id);
}

function underBinding(entry: RunningProcess, bindingId: string): boolean {
  return entry.scope.kind === 'binding' && entry.scope.id === bindingId;
}

/** Kills the whole group, which is why the child was detached in the first place. */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone, or never got a group. Either way there is nothing to signal.
  }
}

/**
 * The one place ownership is decided. Written as a lookup returning the entry
 * rather than a boolean at each call site, so a caller cannot hold a process it
 * did not prove it owns.
 */
function ownedBy(
  processId: string,
  ownerRunId: string,
  bindingId: string,
): RunningProcess | undefined {
  const entry = running.get(processId);
  if (entry === undefined) return undefined;
  // Both, not either. A run holding two bindings could otherwise name the one
  // still granted, pass the gate on it, and go on driving a process inside the
  // binding that was withdrawn.
  if (entry.ownerRunId !== ownerRunId) return undefined;
  return underBinding(entry, bindingId) ? entry : undefined;
}

/**
 * A handle answers only to the run that owns it. A process belonging to another
 * run is reported as absent rather than refused, because saying "not yours"
 * confirms the id exists, and an id is the only thing that has to be guessed.
 */
export function lookupProcess(
  processId: string,
  ownerRunId: string,
  bindingId: string,
):
  | {
      state: 'running' | 'exited';
      startedAt: Date;
      exitCode: number | null;
      output: string;
      truncated: boolean;
    }
  | undefined {
  const entry = ownedBy(processId, ownerRunId, bindingId);
  if (entry === undefined) return undefined;
  const output = entry.buffered;
  const truncated = entry.bufferTruncated;
  // Both cleared: the flag describes the read being returned, so leaving it set
  // would mark every later inspection as lossy long after nothing was lost.
  entry.buffered = '';
  entry.bufferTruncated = false;
  return {
    state: entry.exited ? 'exited' : 'running',
    startedAt: entry.startedAt,
    exitCode: entry.exitCode,
    output,
    truncated,
  };
}

/** Write to a running process's standard input. Ownership is checked first. */
export function writeToProcess(
  processId: string,
  ownerRunId: string,
  bindingId: string,
  text: string,
): 'written' | 'not_found' | 'exited' | 'no_stdin' {
  const entry = ownedBy(processId, ownerRunId, bindingId);
  if (entry === undefined) return 'not_found';
  if (entry.exited) return 'exited';
  const stdin = entry.child.stdin;
  if (!stdin || stdin.destroyed) return 'no_stdin';
  stdin.write(text);
  return 'written';
}

export function processesForBinding(
  bindingId: string,
  ownerRunId: string,
  processId?: string,
): Array<[string, { child: ChildProcess; exited: boolean }]> {
  return [...running.entries()]
    .filter(
      ([id, entry]) =>
        underBinding(entry, bindingId) &&
        entry.ownerRunId === ownerRunId &&
        (processId === undefined || id === processId),
    )
    .map(([id, entry]) => [id, entry] as [string, { child: ChildProcess; exited: boolean }]);
}

/**
 * Kill anything running under a binding the machine no longer grants.
 *
 * Withdrawal used to reach a process only when someone named that same binding
 * again — but detaching exists so the step can end, so in the ordinary case
 * nothing ever names it and a shell kept its access to a withdrawn folder until
 * its timeout. Reconciling against the whole current policy costs nothing
 * extra: the policy was already read to serve this operation.
 */
export function reapWithdrawn(permitted: ExecutionPermitted): string[] {
  const killed: string[] = [];
  for (const [id, entry] of running) {
    if (entry.exited || scopePermitted(entry.scope, permitted)) continue;
    signalGroup(entry.child, 'SIGKILL');
    killed.push(id);
  }
  return killed;
}

/**
 * Kill every process started under a binding, whoever owns it.
 *
 * For revocation: an operator withdrawing a binding is withdrawing it from
 * everything, and a shell that outlived the step that started it would
 * otherwise keep the access that was just taken away.
 */
export function killProcessesForBinding(bindingId: string): string[] {
  const killed: string[] = [];
  for (const [id, entry] of running) {
    if (!underBinding(entry, bindingId) || entry.exited) continue;
    signalGroup(entry.child, 'SIGKILL');
    killed.push(id);
  }
  return killed;
}

/** Kill everything this executor started, for shutdown. */
export function killAllProcesses(): number {
  let killed = 0;
  for (const [, entry] of running) {
    if (entry.exited) continue;
    signalGroup(entry.child, 'SIGKILL');
    killed += 1;
  }
  return killed;
}

/**
 * Whether this machine can actually confine a workload.
 *
 * Two questions, and asking only the first was wrong. `isSupportedPlatform`
 * says the operating system has a mechanism — on Linux it is true whether or
 * not `bwrap`, `rg` and `socat` are installed. A machine missing them passed
 * this check, spawned, and failed with a dependency error indistinguishable
 * from the command's own failure: the refusal that exists to say "nothing runs
 * here unconfined" never appeared, and the operator was left reading an exit
 * code.
 *
 * Named rather than boolean, because "install these three packages" is the
 * whole of what a Linux operator needs, and the refusal is the only place they
 * will see it.
 */
export function sandboxReadiness(): { ready: boolean; missing: string[] } {
  if (!SandboxManager.isSupportedPlatform()) {
    return { ready: false, missing: ['a sandbox mechanism for this operating system'] };
  }
  try {
    const missing = SandboxManager.checkDependencies().errors ?? [];
    return { ready: missing.length === 0, missing: [...missing] };
  } catch (error) {
    // A dependency check that cannot run is not evidence that dependencies are
    // present. Fail closed, as everywhere else here.
    return {
      ready: false,
      missing: [error instanceof Error ? error.message : 'the dependency check did not complete'],
    };
  }
}

export function sandboxAvailable(): boolean {
  return sandboxReadiness().ready;
}

export function noSandboxMessage(missing: readonly string[]): string {
  return (
    'This machine has no qualified sandbox, so commands cannot be confined here. ' +
    'Running them unconfined is a decision the operator makes deliberately, not a fallback.' +
    (missing.length > 0 ? ` Missing: ${missing.join('; ')}.` : '')
  );
}

/** For callers reporting the refusal without naming what is missing. */
export const NO_SANDBOX_MESSAGE = noSandboxMessage([]);

export interface SpawnConfinedInput {
  readonly binding: HostBinding;
  readonly argv: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly trustedEnv?: Record<string, string>;
  readonly scratchDir: string;
  readonly widening?: SandboxWidening;
  readonly inheritEnv?: readonly string[];
  readonly idPrefix: string;
  readonly ownerRunId: string;
  readonly toolPaths?: readonly string[];
}

export interface ConfinedProcess {
  readonly processId: string;
  readonly child: ChildProcess;
  readonly startedAt: Date;
  /** Registry entry, so a caller can see it exit without a second listener. */
  readonly entry: { exited: boolean; exitCode: number | null };
}

/**
 * Everything about running a process that does not depend on how it is
 * confined: the working directory, the deadline, the live feed, the handle it
 * becomes. Both paths below supply it, and both are supervised by the same code.
 */
export interface SupervisedRun {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly idPrefix: string;
  /** The run this process answers to. */
  readonly ownerRunId: string;
  /**
   * Return as soon as it starts rather than when it finishes, leaving a handle
   * addressable by `inspect`, `input` and `stop`. A shell worth keeping open is
   * one nobody can wait for.
   */
  readonly detach?: boolean;
  /**
   * End the child's standard input the moment it starts. A workload that reads
   * stdin before doing anything — harness CLIs wait several seconds for a pipe
   * nobody is writing to — sees end-of-input instead of waiting out that timer.
   * Left open for anything `host.process.input` must be able to answer.
   */
  readonly closeStdin?: boolean;
  /**
   * A credential this run was given. Removed from captured output and from
   * every live delta before either leaves this function — the deltas go to a
   * durable stream, so scrubbing only the final result publishes it anyway.
   */
  readonly secret?: string;
  readonly signal: AbortSignal;
  /**
   * Live output, chunk by chunk: standard output always, standard error only
   * when `liveStderr`.
   */
  readonly onDelta: (text: string) => void;
  /**
   * Stream standard error live as well. A command's progress often speaks
   * there, so `host.process.exec` asks for it; a harness does not, because its
   * standard error is the sandbox's debug channel as much as the workload's.
   * `stderr` on the result carries it either way.
   */
  readonly liveStderr?: boolean;
  /**
   * Called for every chunk either stream produced, before any of it is capped,
   * scrubbed or withheld. A streaming host step's deadline slides on progress
   * and the live delta was the only thing reporting any, so a workload
   * narrating steadily on standard error was reaped as idle while it worked.
   */
  readonly onOutput?: () => void;
}

export interface SandboxedRunInput extends SupervisedRun {
  readonly binding: HostBinding;
  /** Program and arguments, already split. Nothing here parses a command line. */
  readonly argv: string[];
  /** Job-supplied, and therefore checked against the launcher's own variables. */
  readonly env: Record<string, string>;
  /**
   * Set by this executor rather than by a job — the sandbox's debug channel, a
   * credential the machine's own profile named. Not checked, because it did not
   * come from the wire, and applied after `env` so a job cannot displace it.
   */
  readonly trustedEnv?: Record<string, string>;
  /** Where the compiled policy is written — outside the binding, always. */
  readonly scratchDir: string;
  readonly widening?: SandboxWidening;
  /** Extra names the machine's own policy permits a workload to inherit. */
  readonly inheritEnv?: readonly string[];
  /** Where the machine says the operator's tools live. Read-only. */
  readonly toolPaths?: readonly string[];
}

export interface UnconfinedRunInput extends SupervisedRun {
  readonly binding: HostBinding;
  /** Program and arguments, already split, and already read by the push rule. */
  readonly argv: string[];
}

/** One spawn, supervised, captured and reaped — whatever it was pointed at. */
interface SupervisedSpawn extends SupervisedRun {
  readonly program: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly bindingId: string;
  /**
   * A directory this process alone uses, journalled against its group id and
   * removed when it ends. Absent where the process holds nothing to reclaim, so
   * that nothing hands the orphan sweep a path it must not delete.
   */
  readonly scratchDir?: string;
  /**
   * Where the wrapper around a confined command records the workload's own
   * status. Absent for the one command that runs unconfined: it has no launcher
   * standing between it and this executor, so its exit is already its own.
   */
  readonly statusPath?: string;
}

/**
 * The launcher does not pass a signal death through, so the workload reports
 * for itself.
 *
 * The adapter's CLI supervises the confined command and reports in its place,
 * collapsing every signal other than SIGINT and SIGTERM into `exit 1` and
 * naming the signal on its own standard error. So a command killed by SIGPIPE —
 * what `head` does to whatever feeds it, the moment it has read enough — arrives
 * here as a bare `1` with no signal, indistinguishable from a command that
 * failed on its own.
 *
 * That standard error cannot be the channel this is recovered from. The launcher
 * spawns the command with `stdio: 'inherit'`, so the workload's standard error
 * and the launcher's own line are the same pipe: any command whose closing
 * bytes happened to read like that line would have had its genuine failure
 * rewritten as success.
 *
 * So the workload's status arrives on a channel the workload's streams are not:
 * a minimal `sh` wrapper runs the command and writes its own `$?` — which
 * encodes a signal death the way every shell does, as 128+signal, SIGPIPE as
 * 141 — into a file in the run's scratch directory, which this executor reads
 * back. The wrapper redirects none of the command's streams, keeps its two
 * variables to itself rather than exporting them, and passes the argv through as
 * `"$@"`, so what runs is what was asked for. It adds no shell to the chain that
 * was not there: the launcher hands the command to `bash -c` either way, which
 * is why it re-quotes every argument.
 *
 * The scratch is writable by the workload, which could therefore write this file
 * itself. That buys it nothing it does not already have: a workload chooses its
 * own exit status anyway.
 */
const STATUS_WRAPPER = 'st=$1; shift; "$@"; r=$?; printf %s "$r" >"$st"; exit $r';

/** Where the wrapper writes it: the run's own scratch, never the binding. */
export function workloadStatusPath(scratchDir: string): string {
  return join(scratchDir, 'workload-status');
}

/**
 * The command, wrapped so it reports its own status.
 *
 * `sh` is $0 — conventional, and read by nothing here; the status path is $1,
 * shifted off before the command runs so `"$@"` is exactly the argv as given,
 * with no splitting, quoting or re-parsing of any of it.
 */
export function statusWrappedArgv(statusPath: string, argv: readonly string[]): string[] {
  return ['/bin/sh', '-c', STATUS_WRAPPER, 'sh', statusPath, ...argv];
}

/**
 * The argv handed to the launcher: its own flags, then `--`, then the wrapper.
 *
 * `--` is load-bearing rather than tidy. The launcher's option parser owns
 * `-c <command>` — the same spelling `sh`, `bash` and `python` use — and takes
 * it from anywhere in the argv, so `['python', '-c', 'print(1)']` had its script
 * lifted out and run as a shell command string with `python` dropped. After `--`
 * every word is the command's, which is also what keeps this wrapper intact.
 */
export function confinedArgv(
  srtBin: string,
  settingsPath: string,
  statusPath: string,
  argv: readonly string[],
): string[] {
  return [srtBin, '-s', settingsPath, '--', ...statusWrappedArgv(statusPath, argv)];
}

/** Signal numbers back to names, first spelling winning over each alias. */
const SIGNAL_BY_NUMBER = ((): Map<number, string> => {
  const byNumber = new Map<number, string>();
  for (const [name, number] of Object.entries(constants.signals)) {
    if (!byNumber.has(number)) byNumber.set(number, name);
  }
  return byNumber;
})();

/**
 * The status the wrapper recorded, or nothing.
 *
 * Nothing means the wrapper never got to write it — the whole group was killed,
 * the scratch was already gone — and the caller falls back to what the launcher
 * reported. Never invented: an unreadable status file must not become a success.
 */
export async function readWorkloadStatus(statusPath: string): Promise<number | undefined> {
  let text: string;
  try {
    text = await readFile(statusPath, 'utf8');
  } catch {
    return undefined;
  }
  // Digits and nothing else. The wrapper writes `$?` and only that, so anything
  // else in the file is not a status and is not treated as one.
  if (!/^\d{1,3}$/.test(text.trim())) return undefined;
  const status = Number.parseInt(text.trim(), 10);
  return status <= 255 ? status : undefined;
}

/**
 * What the run meant, given the workload's own status and the launcher's exit.
 *
 * SIGPIPE is not a failure: the reader stopped reading, which is precisely what
 * `head` is for, and every shell reports such a pipeline as succeeding — the
 * only thing lost is output nobody asked for. The output already captured is the
 * whole of what the pipeline was asked to produce, so the run succeeded. A
 * command that deliberately exits 141 is read the same way, because a shell
 * cannot tell those apart either.
 *
 * Every other status keeps its meaning, as the shell spells it: a command that
 * failed on its own carries its own code, and one killed or crashed carries
 * 128+signal and gains the signal's name. With no status recorded, the
 * launcher's own exit and signal stand.
 */
export function resolveConfinedExit(
  launcherExit: number | null,
  launcherSignal: string | null,
  workloadStatus: number | undefined,
): { exitCode: number | null; signal: string | null } {
  if (workloadStatus === undefined) return { exitCode: launcherExit, signal: launcherSignal };
  const signal = workloadStatus > 128 ? SIGNAL_BY_NUMBER.get(workloadStatus - 128) : undefined;
  if (signal === 'SIGPIPE') return { exitCode: 0, signal };
  return { exitCode: workloadStatus, signal: signal ?? null };
}

/**
 * Record a finished process's status on its registry entry.
 *
 * Both spawn paths settle through this. Recording the launcher's raw code on one
 * of them and the workload's status on the other made `host.process.inspect`
 * report the same death differently depending on which path had started it.
 */
async function recordWorkloadExit(
  entry: RunningProcess,
  launcherExit: number | null,
  launcherSignal: NodeJS.Signals | null,
  statusPath: string,
): Promise<void> {
  const status = await readWorkloadStatus(statusPath);
  entry.exitCode = resolveConfinedExit(launcherExit, launcherSignal, status).exitCode;
}

export interface SandboxedRunResult {
  readonly processId: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  /** True when the caller got a handle instead of a finished process. */
  readonly detached?: boolean;
}

/**
 * Start a confined process and put it in the registry, without deciding what
 * happens to it next.
 *
 * Extracted because a caller that spawns its own — the MCP client hands the
 * child's pipes to a protocol library — must still land in the one registry
 * every reaping path consults. A process outside it is reachable by withdrawal,
 * by shutdown and by the next boot's orphan sweep only by accident, which is to
 * say not at all.
 */
export async function spawnConfined(input: SpawnConfinedInput): Promise<ConfinedProcess> {
  assertSafeEnv(input.env);

  // The policy lives outside the binding: a command that could rewrite the
  // file bounding it would not be bounded by it.
  const policy = compileSandboxPolicy(input.binding, {
    scratchDir: input.scratchDir,
    ...(input.widening ? { widening: input.widening } : {}),
    ...(input.toolPaths ? { toolPaths: input.toolPaths } : {}),
  });
  const settingsPath = join(input.scratchDir, 'srt-settings.json');
  await writeFile(settingsPath, JSON.stringify(policy), { mode: 0o600 });

  const srtBin = join(
    dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json')),
    'dist',
    'cli.js',
  );
  const statusPath = workloadStatusPath(input.scratchDir);
  const argv = confinedArgv(srtBin, settingsPath, statusPath, input.argv);

  pruneExited(Date.now());
  const startedAt = new Date();
  await mkdir(workloadHome(input.scratchDir), { recursive: true });
  const child = spawn(process.execPath, argv, {
    cwd: input.cwd,
    env: {
      ...buildBaseEnv(input.scratchDir, input.inheritEnv ?? []),
      ...input.env,
      ...input.trustedEnv,
    },
    // Its own group, so a stop reaches descendants — and so the launcher's own
    // child, which is the real workload, can be signalled at all.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (child.pid !== undefined) recordSpawn(child.pid, input.scratchDir);

  const { processId, entry } = enterRegistry(
    child,
    input.idPrefix,
    { kind: 'binding', id: input.binding.id },
    input.ownerRunId,
    startedAt,
  );
  // Struck from the journal the moment it ends, so what is left there is what
  // is still running. A journal of everything ever spawned is a list of pids
  // the operating system has since reassigned.
  const forget = (): void => {
    if (child.pid !== undefined) forgetSpawn(child.pid);
  };
  child.once('close', (code, signal) => {
    entry.exited = true;
    entry.exitedAt = Date.now();
    forget();
    // The launcher's own code stands until the status file has been read, which
    // is one read of a file a process that has already exited left behind.
    entry.exitCode = code;
    void recordWorkloadExit(entry, code, signal, statusPath);
  });
  child.once('error', () => {
    entry.exited = true;
    entry.exitedAt = Date.now();
    forget();
  });

  return { processId, child, startedAt, entry };
}

/**
 * One spawn, supervised: its own process group, the live feed, the storage cap,
 * the deadline, the abort escalation, and the registry entry every reaping path
 * reads. What differs between a confined command and the one command that runs
 * unconfined is the program and the environment it is handed — not any of this,
 * which is why both paths arrive here rather than each keeping a copy.
 */
async function superviseSpawn(input: SupervisedSpawn): Promise<SandboxedRunResult> {
  pruneExited(Date.now());

  const startedAt = new Date();
  const child = spawn(input.program, input.args, {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    // Piped rather than ignored so a process can be answered. Nothing is
    // written to it unless a caller does; a command reading an empty pipe sees
    // the same end-of-input it saw before.
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Written down before anything else, so a crash between here and the next
  // line still leaves the group findable at the next startup.
  if (child.pid !== undefined && input.scratchDir !== undefined) {
    recordSpawn(child.pid, input.scratchDir);
  }

  if (input.closeStdin === true) child.stdin.end();

  const { processId, entry } = enterRegistry(
    child,
    input.idPrefix,
    { kind: 'binding', id: input.bindingId },
    input.ownerRunId,
    startedAt,
  );

  let stdout = '';
  let stderr = '';
  let truncated = false;
  // One scrubber per stream. Sharing one lets a chunk of stderr flush the tail
  // stdout was holding back, which reassembles a credential split across reads.
  const scrubbers = {
    out: createStreamScrubber(input.secret),
    err: createStreamScrubber(input.secret),
  };
  const detached = input.detach === true;
  const capture = (chunk: string, isErr: boolean): void => {
    // Before anything is withheld: a chunk this function goes on to drop is
    // still the workload proving it is alive to whatever holds the step's idle
    // deadline.
    input.onOutput?.();
    // Every byte, before the budget is consulted. The cap bounds what this run
    // *stores*; applying it to the live path made the feed stop mid-run —
    // deltas are read as they arrive, by a parser that needs the stream's own
    // terminator, so a harness silenced at the cap lost its final event and
    // ended with its answer unparsed. Nothing here is kept, so nothing here
    // needs a ceiling.
    const safe = (isErr ? scrubbers.err : scrubbers.out).push(chunk);
    // Held back by the scrubber, not dropped: it arrives with the chunk that
    // proves it is not half a credential.
    if (safe === '') return;
    // Standard error is live only where the caller asked for it. For a harness
    // it is the sandbox's debug channel as much as the workload's — the proxy,
    // the startup dump, the command echoed back — and narrating that into a
    // session puts the executor's own noise where the workload's words are
    // supposed to be. It is kept, as diagnostics, on the result and in the
    // detached buffer either way.
    if (!isErr || input.liveStderr === true) input.onDelta(safe);

    // A finished run returns its output, so the budget is on the whole of it. A
    // detached one is drained by each inspection and can outlive any total, so
    // its budget is on what is currently held — capping the lifetime total made
    // a long-lived process go permanently silent once it passed it, which reads
    // exactly like a process that has stopped saying anything.
    const held = detached ? entry.buffered.length : stdout.length + stderr.length;
    const room = OUTPUT_CAP_BYTES - held;
    if (room <= 0) {
      if (detached) entry.bufferTruncated = true;
      else truncated = true;
      return;
    }
    const stored = safe.length > room ? safe.slice(0, room) : safe;
    if (safe.length > room) {
      if (detached) entry.bufferTruncated = true;
      else truncated = true;
    }
    if (detached) {
      // Held until someone reads it, because nobody may ever come.
      entry.buffered += stored;
    } else {
      if (isErr) stderr += stored;
      else stdout += stored;
    }
  };
  child.stdout.on('data', (c: Buffer) => {
    capture(c.toString('utf8'), false);
  });
  child.stderr.on('data', (c: Buffer) => {
    capture(c.toString('utf8'), true);
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    signalGroup(child, 'SIGTERM');
    setTimeout(() => {
      signalGroup(child, 'SIGKILL');
    }, SIGKILL_AFTER_MS);
  }, input.timeoutMs);

  // Escalated the way a timeout is. A cancelled step whose workload traps
  // SIGTERM otherwise kept running — with its credentials and its write
  // access — until the original timeout, which for a harness is hours.
  let escalation: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    signalGroup(child, 'SIGTERM');
    escalation ??= setTimeout(() => {
      signalGroup(child, 'SIGKILL');
    }, SIGKILL_AFTER_MS);
  };
  input.signal.addEventListener('abort', onAbort);
  // A signal that fired before the listener existed never delivers, and the
  // run would proceed under a cancellation that already happened.
  if (input.signal.aborted) onAbort();

  // A detached run reports that it started; the handle carries the rest.
  if (detached) {
    // The scratch holds the compiled policy the sandbox launcher reads, and is
    // this process's TMPDIR. A caller cannot clean it up on return the way it
    // does for a run it waited for, so ownership moves here.
    const cleanUp = (): void => {
      // The supervision installed for a run this function waits on outlives a
      // detached one, and both act on the pid: a timeout that fires later, or
      // an abort listener still registered, would signal a process group whose
      // id the kernel may since have handed to something unrelated.
      clearTimeout(timer);
      if (escalation !== undefined) clearTimeout(escalation);
      input.signal.removeEventListener('abort', onAbort);
      if (child.pid !== undefined) forgetSpawn(child.pid);
      if (input.scratchDir !== undefined) {
        void rm(input.scratchDir, { recursive: true, force: true }).catch(() => {});
      }
    };
    child.on('close', (c, s) => {
      entry.exited = true;
      entry.exitCode = c;
      entry.exitedAt = Date.now();
      if (input.statusPath === undefined) {
        cleanUp();
        return;
      }
      // Read before the scratch is removed — the status file lives in it.
      void recordWorkloadExit(entry, c, s, input.statusPath).finally(cleanUp);
    });
    child.on('error', () => {
      entry.exited = true;
      entry.exitedAt = Date.now();
      cleanUp();
    });
    child.unref();
    return {
      processId,
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      detached: true,
    };
  }

  const { code, signal, spawnError } = await new Promise<{
    code: number | null;
    signal: string | null;
    spawnError?: Error;
  }>((resolve) => {
    // An unhandled 'error' event on a child process throws, which would take
    // the executor down on an EMFILE or a missing interpreter. Both 'error'
    // and 'close' can fire; whichever comes first settles the promise.
    child.on('error', (error: Error) => {
      resolve({ code: null, signal: null, spawnError: error });
    });
    child.on('close', (c, s) => {
      resolve({ code: c, signal: s });
    });
  });

  clearTimeout(timer);
  if (escalation !== undefined) clearTimeout(escalation);
  input.signal.removeEventListener('abort', onAbort);

  // Whatever each scrubber held back, released once nothing more can complete a
  // match — and with a trailing partial credential redacted rather than emitted.
  for (const [stream, scrubber] of [
    ['out', scrubbers.out],
    ['err', scrubbers.err],
  ] as const) {
    const held = scrubber.flush();
    if (held === '') continue;
    if (stream === 'err') {
      stderr += held;
      if (input.liveStderr === true) input.onDelta(held);
      continue;
    }
    stdout += held;
    input.onDelta(held);
  }

  const reported = resolveConfinedExit(
    code,
    signal,
    input.statusPath === undefined ? undefined : await readWorkloadStatus(input.statusPath),
  );
  entry.exited = true;
  entry.exitCode = reported.exitCode;
  entry.exitedAt = Date.now();
  if (spawnError) throw spawnError;

  return {
    processId,
    exitCode: reported.exitCode,
    signal: reported.signal,
    timedOut,
    durationMs: Date.now() - startedAt.getTime(),
    stdout,
    stderr,
    truncated,
  };
}

export async function runSandboxed(input: SandboxedRunInput): Promise<SandboxedRunResult> {
  // Checked here rather than at each caller, because this is the process the
  // dangerous variables would act on.
  assertSafeEnv(input.env);

  // The policy lives outside the binding: a command that could rewrite the
  // file bounding it would not be bounded by it.
  const policy = compileSandboxPolicy(input.binding, {
    scratchDir: input.scratchDir,
    ...(input.widening ? { widening: input.widening } : {}),
    ...(input.toolPaths ? { toolPaths: input.toolPaths } : {}),
  });
  const settingsPath = join(input.scratchDir, 'srt-settings.json');
  await writeFile(settingsPath, JSON.stringify(policy), { mode: 0o600 });

  // Resolved from this module, not the working directory. An executor
  // installed on the operator's machine is started from wherever they happen
  // to be, and a cwd-relative path would find the adapter only by luck.
  const srtBin = join(
    dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json')),
    'dist',
    'cli.js',
  );
  await mkdir(workloadHome(input.scratchDir), { recursive: true });

  const statusPath = workloadStatusPath(input.scratchDir);
  return await superviseSpawn({
    ...input,
    program: process.execPath,
    // Argv all the way through: the adapter's CLI takes the command as varargs,
    // so nothing between here and exec has to split or quote a string.
    args: confinedArgv(srtBin, settingsPath, statusPath, input.argv),
    statusPath,
    env: workloadEnv(input),
    bindingId: input.binding.id,
  });
}

/**
 * Named inheritance, never the executor's whole environment: that environment
 * holds the credentials this executor was paired with, whichever way the
 * workload is spawned.
 */
function workloadEnv(input: SandboxedRunInput): Record<string, string> {
  return {
    ...buildBaseEnv(input.scratchDir, input.inheritEnv ?? []),
    ...input.env,
    ...input.trustedEnv,
  };
}

/**
 * Run a coding agent or a folder's checks unconfined, as the operator's own
 * user, in a folder whose sandbox posture is `open` (Plan 315 D19).
 *
 * The environment is the one a confined run is handed, so the run's own
 * `TMPDIR` and `HOME`, its credential, its configuration directory and the ref
 * guard reach it the same way; the widening and tool paths, which only bound a
 * sandbox, are not read. No launcher stands between it and this executor, so
 * its exit is its own.
 */
export async function runOpen(input: SandboxedRunInput): Promise<SandboxedRunResult> {
  assertSafeEnv(input.env);
  const [program, ...args] = input.argv;
  if (program === undefined) throw new Error('A command with no program cannot be run.');
  await mkdir(workloadHome(input.scratchDir), { recursive: true });
  return await superviseSpawn({
    ...input,
    program,
    args,
    env: workloadEnv(input),
    bindingId: input.binding.id,
  });
}

/**
 * Run the command as this executor's own process: the operator's git, their
 * remotes, their keys, their transport, no boundary.
 *
 * Only a permitted push arrives here. The sandbox is there to contain a command
 * nobody has read, and a push that passed `requirePushAllowed` has had every
 * argument read — while its effect lands on a remote the boundary could not see
 * in any case, and the boundary's egress is an authenticating HTTP proxy that
 * git over SSH cannot speak. Confining it does not contain the push; it prevents
 * one the operator permitted.
 */
export async function runUnconfined(input: UnconfinedRunInput): Promise<SandboxedRunResult> {
  const [program, ...args] = input.argv;
  if (program === undefined) throw new Error('A command with no program cannot be run.');
  return await superviseSpawn({
    ...input,
    program,
    args,
    // The operator's transport, under which the push's target was checked,
    // and nothing more: `GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS` or
    // `GIT_CONFIG_SYSTEM` in the executor's own environment would send the
    // push somewhere that check never resolved. A job adding to it would be
    // choosing what git executes, which is why the push rule refuses a job
    // environment outright.
    env: transportEnv(),
    bindingId: input.binding.id,
  });
}

export interface ServiceStartInput {
  /** Program and arguments, already split, built by this executor and never by a job. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly idPrefix: string;
  /**
   * What reaps it: withdrawal ends it when the policy no longer grants this
   * scope, as it ends a command under a withdrawn binding.
   */
  readonly scope: ProcessScope;
  /**
   * The whole environment, built by the caller from names it chose. Nothing of
   * this executor's own is passed through.
   */
  readonly env: Readonly<Record<string, string>>;
}

export interface ServiceExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The end of what it wrote to standard error, for a refusal to quote. */
  readonly stderrTail: string;
}

export interface RunningService {
  readonly processId: string;
  readonly exited: Promise<ServiceExit>;
  /** End its group politely, then for it. */
  stop(): void;
}

const SERVICE_STDERR_TAIL_CHARS = 4_000;

/**
 * Start a long-lived process this executor serves from — the operator's own
 * browser — unconfined, outside any binding, and running until it is stopped.
 *
 * Unconfined for the reason the push is: the sandbox cannot hold it. Unlike a
 * push it is nobody's step, so it has no deadline and no output anyone reads;
 * what it shares with every other spawn is the registry, the orphan journal and
 * the group kill, which is what puts it in reach of withdrawal, shutdown and the
 * next boot's sweep. It sees the environment its caller named and nothing a job sent.
 */
export function startUnconfinedService(input: ServiceStartInput): RunningService {
  const [program, ...args] = input.argv;
  if (program === undefined) throw new Error('A service with no program cannot be started.');
  pruneExited(Date.now());

  const child = spawn(program, args, {
    cwd: input.cwd,
    env: { ...input.env },
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // No scratch directory: nothing it uses is this executor's to delete.
  if (child.pid !== undefined) recordSpawn(child.pid);
  const { processId, entry } = enterRegistry(child, input.idPrefix, input.scope, '', new Date());

  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-SERVICE_STDERR_TAIL_CHARS);
  });

  const exited = new Promise<ServiceExit>((resolve) => {
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (entry.exited) return;
      entry.exited = true;
      entry.exitCode = code;
      entry.exitedAt = Date.now();
      if (child.pid !== undefined) forgetSpawn(child.pid);
      resolve({ code, signal, stderrTail });
    };
    child.once('close', settle);
    child.once('error', (error: Error) => {
      stderrTail = `${stderrTail}${error.message}`.slice(-SERVICE_STDERR_TAIL_CHARS);
      settle(null, null);
    });
  });
  child.unref();

  return {
    processId,
    exited,
    stop: () => {
      if (entry.exited) return;
      signalGroup(child, 'SIGTERM');
      setTimeout(() => {
        if (!entry.exited) signalGroup(child, 'SIGKILL');
      }, SIGKILL_AFTER_MS).unref();
    },
  };
}
