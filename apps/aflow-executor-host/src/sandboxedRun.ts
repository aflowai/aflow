/**
 * The one place this executor spawns anything.
 *
 * Commands and coding harnesses differ in what they are asked to do and in how
 * much of the boundary they need open, and a permitted push differs further
 * still — it runs unconfined, as the operator's own git. None of them differ in
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
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

import { buildBaseEnv, workloadHome } from './baseEnv.js';
import type { HostBinding } from './bindings.js';
import { createStreamScrubber } from './credentialFetch.js';
import { assertSafeEnv } from './envPolicy.js';
import { forgetSpawn, recordSpawn } from './orphans.js';
import { compileSandboxPolicy, type SandboxWidening } from './sandboxPolicy.js';

/** Captured output is capped so one chatty build cannot become the step's payload. */
export const OUTPUT_CAP_BYTES = 256 * 1024;

/** How long a workload gets to end politely before it is ended for it. */
const SIGKILL_AFTER_MS = 5_000;

interface RunningProcess {
  readonly child: ChildProcess;
  readonly bindingId: string;
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
  return entry.bindingId === bindingId ? entry : undefined;
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
        entry.bindingId === bindingId &&
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
export function reapWithdrawn(permitted: ReadonlySet<string>): string[] {
  const killed: string[] = [];
  for (const [id, entry] of running) {
    if (entry.exited || permitted.has(entry.bindingId)) continue;
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
    if (entry.bindingId !== bindingId || entry.exited) continue;
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
  const argv = [srtBin, '-s', settingsPath, ...input.argv];

  pruneExited(Date.now());
  const processId = nextProcessId(input.idPrefix);
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

  const entry: RunningProcess = {
    child,
    bindingId: input.binding.id,
    ownerRunId: input.ownerRunId,
    startedAt,
    exitCode: null,
    exited: false,
    buffered: '',
    bufferTruncated: false,
  };
  running.set(processId, entry);
  // Struck from the journal the moment it ends, so what is left there is what
  // is still running. A journal of everything ever spawned is a list of pids
  // the operating system has since reassigned.
  const forget = (): void => {
    if (child.pid !== undefined) forgetSpawn(child.pid);
  };
  child.once('close', (code) => {
    entry.exited = true;
    entry.exitCode = code;
    entry.exitedAt = Date.now();
    forget();
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

  const processId = nextProcessId(input.idPrefix);
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

  const entry: RunningProcess = {
    child,
    bindingId: input.bindingId,
    ownerRunId: input.ownerRunId,
    startedAt,
    exitCode: null,
    exited: false,
    buffered: '',
    bufferTruncated: false,
  };
  running.set(processId, entry);

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
    child.on('close', (c) => {
      entry.exited = true;
      entry.exitCode = c;
      entry.exitedAt = Date.now();
      cleanUp();
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

  entry.exited = true;
  entry.exitCode = code;
  entry.exitedAt = Date.now();
  if (spawnError) throw spawnError;

  return {
    processId,
    exitCode: code,
    signal,
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

  return await superviseSpawn({
    ...input,
    program: process.execPath,
    // Argv all the way through: the adapter's CLI takes the command as varargs,
    // so nothing between here and exec has to split or quote a string.
    args: [srtBin, '-s', settingsPath, ...input.argv],
    // Named inheritance, never the executor's whole environment: that
    // environment holds the credentials this executor was paired with.
    env: {
      ...buildBaseEnv(input.scratchDir, input.inheritEnv ?? []),
      ...input.env,
      ...input.trustedEnv,
    },
    bindingId: input.binding.id,
  });
}

/**
 * Run the command as this executor's own process: the operator's git, their
 * remotes, their keys, their environment, no boundary.
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
    // The operator's own, unchanged: this is their git, running where they run
    // it. A job adding to it would be choosing what git executes, which is why
    // the push rule refuses a job environment outright.
    env: process.env,
    bindingId: input.binding.id,
  });
}
