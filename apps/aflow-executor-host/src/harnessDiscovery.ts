/**
 * Which coding harnesses are installed here, observed rather than declared.
 *
 * Discovery is deliberately not configuration: finding `claude` on PATH says
 * the operator could run it, never that this instance may. A found harness is
 * offered; adding it to the machine policy is a separate, deliberate act, and
 * until then nothing can address it.
 *
 * The invocation shape for a discovered harness is the one thing here that
 * cannot be probed — a CLI does not describe how to hand it a prompt. So the
 * suggestion carries what a candidate would look like, and the operator
 * confirms it. Nothing is written from a guess.
 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { HarnessOutputFormat } from './harnessProfiles.js';

const run = promisify(execFile);

/** As in `runtimes.ts`: discovery runs operator-controlled programs. */
function probeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

const PROBE_TIMEOUT_MS = 5_000;

/**
 * The system temp directory as the kernel sees it. `/tmp` is a symlink to
 * `/private/tmp` on macOS, and a policy naming the link does not grant the
 * target — so a grant written as `/tmp` silently fails to apply.
 */
const SYSTEM_TEMP_ROOT = ((): string => {
  try {
    return realpathSync('/tmp');
  } catch {
    return tmpdir();
  }
})();

interface HarnessProbe {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  /** How this CLI takes a prompt non-interactively, per its own `--help`. */
  readonly promptArgs: string[];
  /** Fixed arguments a headless, confined run needs. Measured, not guessed. */
  readonly args: string[];
  /** What those arguments make it print, so a run knows how to read it. */
  readonly output: HarnessOutputFormat;
  /** How it names a conversation, and picks one back up. Empty if it cannot. */
  readonly sessionArgs: string[];
  readonly resumeArgs: string[];
  /** How it takes a turn budget. Empty when the CLI has no such flag. */
  readonly turnsArgs: string[];
  /** How it is told which model to run. Empty when the CLI takes no such argument. */
  readonly modelArgs: string[];
  /** How it is handed an MCP configuration file. Empty when it cannot be. */
  readonly mcpArgs: string[];
  /** Where it keeps the credential the operator already signed in with. */
  readonly authPaths: string[];
  /** Scratch outside the worktree it needs to write, relative to `/tmp`. */
  readonly writePaths: string[];
  /** A variable that takes a per-run configuration directory, if it has one. */
  readonly configDirEnv?: string;
}

/**
 * The harnesses this lane was built against.
 *
 * Egress is not listed for any of them. The host a harness talks to depends on
 * which backend the operator pointed it at, and a run reports every host it was
 * refused — a list written here would be a constant pretending to be a fact.
 *
 * The arguments are not a style preference. A headless run has nobody to answer
 * a permission prompt, so a harness that stages an edit and waits produces
 * nothing; and the flags that skip a harness's own hooks and background
 * prefetches both narrow what it reaches and remove an execution surface the
 * repository would otherwise control. Both were measured on a real run rather
 * than taken from documentation.
 */
const KNOWN: readonly HarnessProbe[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    promptArgs: ['-p', '{prompt}'],
    // A harness's own permission prompts assume an operator watching; there is
    // none here, so every one of them is a run that stops and produces nothing.
    // What confines this run is the operating system — the worktree is the only
    // writable place, home is denied, egress is one declared host — and that
    // holds whatever the harness decides to do. `acceptEdits` is not enough:
    // it lets the harness write but not run, which costs it the ability to
    // build or test what it wrote, and a change nobody could verify is the
    // weaker result. `--bare` skips hooks, plugin sync and background
    // prefetches: fewer hosts reached, and no repository-controlled hook
    // running inside the harness.
    //
    // It also prints its headless event stream rather than one final block of
    // prose, which is what lets a step show what the harness is doing while it
    // is still doing it. `--verbose` is not optional decoration: the CLI
    // refuses `--output-format stream-json` under `--print` without it, before
    // the run starts.
    args: [
      '--permission-mode',
      'bypassPermissions',
      '--bare',
      '--output-format',
      'stream-json',
      '--verbose',
    ],
    output: 'claude-stream-json',
    // It takes a conversation id rather than reporting one, so the id can be
    // minted here and never has to be parsed back out of its output.
    sessionArgs: ['--session-id', '{session}'],
    resumeArgs: ['--resume', '{session}'],
    // Measured against the installed CLI, which takes `--max-turns <turns>` and
    // validates it as a number before the run starts. It is absent from
    // `--help`, so the option parser is what says it exists: an unknown option
    // is refused by name, and this one is not.
    turnsArgs: ['--max-turns', '{turns}'],
    // Measured against the installed CLI alongside the headless flags above: it
    // takes `--model <model>`, and the init event of the run echoes back the
    // name it was given. A name the CLI does not know is reported by the CLI as
    // an unrecognised model rather than refused at parse, so what this grants is
    // the harness's own vocabulary, not this platform's catalog.
    modelArgs: ['--model', '{model}'],
    // Measured under the headless flags above: given a file declaring a stdio
    // server, the init event reports it connected and the model calls its
    // tools. `--strict-mcp-config` keeps out every server the operator
    // configured for their own sessions, so the run reaches only the browser.
    mcpArgs: ['--mcp-config', '{mcpConfig}', '--strict-mcp-config'],
    // Given a configuration directory of its own it reads nothing under home,
    // so nothing is carved out of the standing denial.
    authPaths: [],
    configDirEnv: 'CLAUDE_CONFIG_DIR',
    // Its shell tool builds a sandbox of its own under a uid-scoped directory
    // in the system temp root. Without this the tool fails before any command
    // runs, which costs the harness the ability to build or test what it wrote.
    //
    // Scoped to that directory rather than the whole temp root. The root is
    // shared: on Linux it is also where this lane puts every worktree and every
    // compiled policy, so granting it would let one run read and modify
    // another's — the isolation the worktree exists to provide, given away to
    // avoid one error message.
    //
    // The cost, stated because it is real: the harness's shell writes a
    // working-directory marker directly in the temp root, and cannot. Commands
    // run and produce output, but the shell reports a non-zero exit, so a
    // harness asked to run tests may believe they failed. An operator who would
    // rather have accurate exit codes than per-run isolation can widen this in
    // their own profile; it is not the default, because the default should not
    // trade isolation for tidiness.
    writePaths: [join(SYSTEM_TEMP_ROOT, `claude-${String(process.getuid?.() ?? 0)}`)],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    promptArgs: ['run', '{prompt}'],
    args: [],
    output: 'text',
    sessionArgs: [],
    resumeArgs: [],
    turnsArgs: [],
    // Not installed on the machine this was written on, so nothing about its
    // flags is measured. Empty is the honest answer: a run naming a model is
    // refused by name, where a guessed flag would fail inside the harness.
    modelArgs: [],
    mcpArgs: [],
    authPaths: ['.config/opencode', '.local/share/opencode'],
    writePaths: [],
  },
];

/**
 * The MCP arguments measured for a harness this lane knows, for a profile
 * written before they were; nothing when none were measured for it.
 */
export function knownMcpArgs(harnessId: string): string[] | undefined {
  const args = KNOWN.find((probe) => probe.id === harnessId)?.mcpArgs;
  return args === undefined || args.length === 0 ? undefined : [...args];
}

export interface DiscoveredHarness {
  readonly id: string;
  readonly label: string;
  /** Resolved absolute path, so the policy records what was found, not a name. */
  readonly executable: string;
  readonly version: string;
  /** A starting profile for the operator to confirm — never written on its own. */
  readonly suggested: {
    readonly promptArgs: string[];
    readonly args: string[];
    readonly output: HarnessOutputFormat;
    readonly sessionArgs: string[];
    readonly resumeArgs: string[];
    readonly turnsArgs: string[];
    readonly modelArgs: string[];
    readonly mcpArgs: string[];
    readonly authPaths: string[];
    readonly writePaths: string[];
    readonly configDirEnv?: string;
  };
}

async function resolveExecutable(command: string): Promise<string | null> {
  try {
    const { stdout } = await run('which', [command], {
      timeout: PROBE_TIMEOUT_MS,
      env: probeEnv(),
    });
    const path = stdout.split('\n')[0]?.trim();
    return path === undefined || path === '' ? null : path;
  } catch {
    return null;
  }
}

export async function discoverHarnesses(home = homedir()): Promise<DiscoveredHarness[]> {
  const found = await Promise.all(
    KNOWN.map(async (probe): Promise<DiscoveredHarness | null> => {
      const executable = await resolveExecutable(probe.command);
      if (executable === null) return null;

      let version = 'installed';
      try {
        const { stdout, stderr } = await run(executable, ['--version'], {
          timeout: PROBE_TIMEOUT_MS,
          env: probeEnv(),
        });
        version =
          (stdout.split('\n')[0] ?? '').trim() || (stderr.split('\n')[0] ?? '').trim() || version;
      } catch {
        // A harness that will not report a version may still run. Absence of a
        // version is not absence of the tool, and only the latter disqualifies.
      }

      return {
        id: probe.id,
        label: probe.label,
        executable,
        version,
        suggested: {
          promptArgs: [...probe.promptArgs],
          args: [...probe.args],
          output: probe.output,
          sessionArgs: [...probe.sessionArgs],
          resumeArgs: [...probe.resumeArgs],
          turnsArgs: [...probe.turnsArgs],
          modelArgs: [...probe.modelArgs],
          mcpArgs: [...probe.mcpArgs],
          authPaths: probe.authPaths.map((p) => join(home, p)),
          writePaths: [...probe.writePaths],
          ...(probe.configDirEnv !== undefined ? { configDirEnv: probe.configDirEnv } : {}),
        },
      };
    }),
  );
  return found.filter((h): h is DiscoveredHarness => h !== null);
}
