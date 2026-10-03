/**
 * What the lane proves at boot about the `open` posture (Plan 315 D19): that
 * inside it a shell command exits 0, `yarn --version` runs and a loopback
 * server is reachable — the three things the sandbox refused a coding agent
 * before the posture opened them (F84, F85, F82). Measured on this machine,
 * through the spawn every coding agent and check takes, because what the
 * sandbox admits depends on the operating system and the toolchain it finds.
 *
 * A failure is reported, not fatal: the lane still serves files, commands and
 * `confined` folders, and the operator reads which probe failed and why.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutorLogger } from '@aflow/executor-runtime';

import type { HostBinding } from './bindings.js';
import { runUnderFolderPosture } from './folderRun.js';
import {
  sandboxReadiness,
  type SandboxedRunInput,
  type SandboxedRunResult,
} from './sandboxedRun.js';
import { SYSTEM_TEMP_ROOT } from './sandboxPolicy.js';

export const SELF_TEST_SCRATCH_PREFIX = 'aflow-self-test-';
/** Long enough for Corepack to fetch a Yarn it has not cached. */
export const SELF_TEST_PROBE_TIMEOUT_MS = 120_000;
const SELF_TEST_OWNER = 'host-self-test';

type Spawn = (input: SandboxedRunInput) => Promise<SandboxedRunResult>;

export interface SelfTestProbe {
  readonly name: string;
  readonly argv: readonly string[];
}

export interface SelfTestOutcome {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/**
 * A server on loopback and a connection to it, in one process: what a test
 * that serves itself does.
 */
const LOOPBACK_ROUND_TRIP = [
  "const net = require('net');",
  "const server = net.createServer((socket) => socket.end('pong'));",
  "server.listen(0, '127.0.0.1', () => {",
  "  net.connect(server.address().port, '127.0.0.1')",
  "    .on('data', (data) => { process.stdout.write(String(data)); process.exit(0); })",
  "    .on('error', (error) => { process.stderr.write(error.code ?? error.message); process.exit(1); });",
  '});',
  "server.on('error', (error) => { process.stderr.write(error.code ?? error.message); process.exit(1); });",
].join('\n');

/**
 * The shell probe writes its working directory to a file in the system
 * temporary directory and removes it, as a coding agent's shell does after
 * every command.
 */
export function openPostureProbes(): SelfTestProbe[] {
  const cwdFile = join(SYSTEM_TEMP_ROOT, `${SELF_TEST_SCRATCH_PREFIX}${randomUUID()}-cwd`);
  return [
    {
      name: 'a shell command exits 0',
      argv: ['/bin/sh', '-c', 'pwd -P >"$1" && rm -f "$1"', 'sh', cwdFile],
    },
    { name: '`yarn --version` runs', argv: ['yarn', '--version'] },
    {
      name: 'a loopback server is reachable',
      argv: [process.execPath, '-e', LOOPBACK_ROUND_TRIP],
    },
  ];
}

/** Each probe under `open`, in a folder and checkout of the self-test's own. */
export async function runOpenPostureSelfTest(
  run: Spawn = runUnderFolderPosture,
): Promise<SelfTestOutcome[]> {
  const scratch = await mkdtemp(join(tmpdir(), SELF_TEST_SCRATCH_PREFIX));
  try {
    const root = join(scratch, 'folder');
    const checkout = join(scratch, 'checkout');
    await mkdir(root, { recursive: true });
    await mkdir(checkout, { recursive: true });
    const binding: HostBinding = {
      id: SELF_TEST_OWNER,
      root,
      mode: 'readwrite',
      allowsExecution: true,
      singleFile: false,
      sandbox: 'open',
    };
    const outcomes: SelfTestOutcome[] = [];
    for (const probe of openPostureProbes()) {
      outcomes.push(await runProbe(run, probe, binding, checkout, scratch));
    }
    return outcomes;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function runProbe(
  run: Spawn,
  probe: SelfTestProbe,
  binding: HostBinding,
  checkout: string,
  scratch: string,
): Promise<SelfTestOutcome> {
  // A scratch of the probe's own: the policy and the status file live there.
  const probeScratch = await mkdtemp(join(scratch, 'probe-'));
  try {
    const result = await run({
      binding,
      argv: [...probe.argv],
      cwd: checkout,
      env: {},
      timeoutMs: SELF_TEST_PROBE_TIMEOUT_MS,
      scratchDir: probeScratch,
      widening: {
        authPaths: [],
        allowedDomains: [],
        writableRoot: checkout,
        withholdBindingWrite: true,
      },
      idPrefix: 'st',
      ownerRunId: SELF_TEST_OWNER,
      signal: new AbortController().signal,
      closeStdin: true,
      onDelta: () => undefined,
    });
    if (result.exitCode === 0) return { name: probe.name, passed: true };
    const said = (result.stderr.trim() || result.stdout.trim()).slice(-500);
    return {
      name: probe.name,
      passed: false,
      detail: result.timedOut
        ? `did not finish within ${String(SELF_TEST_PROBE_TIMEOUT_MS / 1000)} s`
        : `exited ${String(result.exitCode ?? result.signal)}${said === '' ? '' : `: ${said}`}`,
    };
  } catch (error) {
    return {
      name: probe.name,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Run the self-test and say what it found; never throws. */
export async function reportOpenPostureSelfTest(log: ExecutorLogger): Promise<void> {
  const readiness = sandboxReadiness();
  if (!readiness.ready) {
    log.warn(
      "This machine has no qualified sandbox, so no folder's coding agent or checks can run " +
        'here, `open` or `confined`.',
      { missing: readiness.missing.join('; ') },
    );
    return;
  }
  const outcomes = await runOpenPostureSelfTest().catch((error: unknown) => [
    {
      name: 'the self-test',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    },
  ]);
  const failed = outcomes.filter((outcome) => !outcome.passed);
  if (failed.length === 0) {
    log.info('The open posture admits what a coding agent needs', {
      probes: outcomes.map((outcome) => outcome.name).join('; '),
    });
    return;
  }
  for (const outcome of failed) {
    log.error(`Under the open posture, ${outcome.name} failed on this machine`, {
      detail: outcome.detail ?? 'no detail',
    });
  }
}
