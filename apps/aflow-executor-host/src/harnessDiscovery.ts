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

import { probeEnv } from './probeEnv.js';

import type { HarnessMcpFormat, HarnessOutputFormat } from './harnessProfiles.js';

const run = promisify(execFile);

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
  /** How it is handed an MCP server. Empty when it cannot be. */
  readonly mcpArgs: string[];
  /** What those arguments hand over: a configuration file, or the server inline. */
  readonly mcpFormat: HarnessMcpFormat;
  /** Where it keeps the credential the operator already signed in with. */
  readonly authPaths: string[];
  /** Scratch outside the worktree it needs to write, relative to `/tmp`. */
  readonly writePaths: string[];
  /** A variable that takes a per-run configuration directory, if it has one. */
  readonly configDirEnv?: string;
  /** Its sign-in files, relative to home, lent into that directory per turn. */
  readonly configSeed: string[];
  /** How long a sign-in file goes unwritten before the harness refreshes it on start. */
  readonly configSeedRefreshAgeMs?: number;
  /** Variables it needs to run inside the boundary at all. */
  readonly env: Record<string, string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

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
    mcpFormat: 'claude-json',
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
    // The working-directory marker its shell writes after every command goes
    // where `CLAUDE_CODE_TMPDIR` says, and the lane points that at the run's
    // own temporary directory (`baseEnv.ts`); left to itself it writes the temp
    // root, is refused, and every command reads as failed.
    writePaths: [join(SYSTEM_TEMP_ROOT, `claude-${String(process.getuid?.() ?? 0)}`)],
    configSeed: [],
    env: {},
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    promptArgs: ['{prompt}'],
    // Measured against Codex CLI 0.163 (Plan 325 §6). The bypass flag is what
    // `bypassPermissions` is for Claude Code: Codex's own Seatbelt profile
    // cannot nest inside the lane's, and the lane's sandbox is the boundary.
    // The disables are its `--bare`: a fresh CODEX_HOME already drops the
    // operator's plugins, hooks and notify program, and these stop the run
    // fetching ChatGPT app connectors, remote plugins and dependency installs,
    // or reaching for a browser or the desktop the run did not ask for.
    // `secret_auth_storage` is held off because the sign-in is lent as a file.
    args: [
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      ...[
        'apps',
        'plugins',
        'remote_plugin',
        'hooks',
        'computer_use',
        'browser_use',
        'browser_use_external',
        'skill_mcp_dependency_install',
        'secret_auth_storage',
      ].flatMap((feature) => ['--disable', feature]),
    ],
    output: 'codex-jsonl',
    // It takes no conversation id. It reports its own as the first event of
    // the run, and `exec`'s flags carry over when `resume` follows them.
    sessionArgs: [],
    resumeArgs: ['resume', '{session}'],
    // No turn flag exists; a run is bounded by its timeout.
    turnsArgs: [],
    modelArgs: ['-m', '{model}'],
    // It takes no configuration file. Measured: one `-c` declaring a stdio
    // server inline connects it, and the model calls its tools (§6 M3). A
    // fresh CODEX_HOME holds no other server, so nothing else is reached.
    mcpArgs: ['-c', '{mcpServers}'],
    mcpFormat: 'codex-toml',
    authPaths: [],
    writePaths: [],
    configDirEnv: 'CODEX_HOME',
    configSeed: ['.codex/auth.json'],
    // Codex refreshes a sign-in older than eight days when it starts. A day
    // of margin costs only that runs seeded in it take turns.
    configSeedRefreshAgeMs: 7 * DAY_MS,
    // On macOS it verifies TLS through the trust daemon unless handed a
    // bundle, and the boundary never grants that daemon: it is an egress path
    // of its own (`sandboxPolicy.ts`). Measured: without this every request
    // fails just after the proxy accepts its CONNECT; with it the run
    // completes (Plan 325 §6 M6). Elsewhere it reads the system's bundle files,
    // which the boundary leaves readable.
    env: process.platform === 'darwin' ? { CODEX_CA_CERTIFICATE: '/etc/ssl/cert.pem' } : {},
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
    mcpFormat: 'claude-json',
    authPaths: ['.config/opencode', '.local/share/opencode'],
    writePaths: [],
    configSeed: [],
    env: {},
  },
];

/**
 * The MCP arguments measured for a harness this lane knows, with the format
 * they carry, for a profile written before they were; nothing when none were
 * measured for it.
 */
export function knownMcp(
  harnessId: string,
): { readonly args: string[]; readonly format: HarnessMcpFormat } | undefined {
  const probe = KNOWN.find((known) => known.id === harnessId);
  if (probe === undefined || probe.mcpArgs.length === 0) return undefined;
  return { args: [...probe.mcpArgs], format: probe.mcpFormat };
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
    readonly mcpFormat: HarnessMcpFormat;
    readonly authPaths: string[];
    readonly writePaths: string[];
    readonly configDirEnv?: string;
    readonly configSeed: string[];
    readonly configSeedRefreshAgeMs?: number;
    readonly env: Record<string, string>;
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
          mcpFormat: probe.mcpFormat,
          authPaths: probe.authPaths.map((p) => join(home, p)),
          writePaths: [...probe.writePaths],
          ...(probe.configDirEnv !== undefined ? { configDirEnv: probe.configDirEnv } : {}),
          configSeed: probe.configSeed.map((p) => join(home, p)),
          ...(probe.configSeedRefreshAgeMs !== undefined
            ? { configSeedRefreshAgeMs: probe.configSeedRefreshAgeMs }
            : {}),
          env: { ...probe.env },
        },
      };
    }),
  );
  return found.filter((h): h is DiscoveredHarness => h !== null);
}
