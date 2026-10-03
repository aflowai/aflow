/**
 * What the lane proves at boot about the `open` posture (Plan 315 D19): that
 * inside it a shell command exits 0 and `yarn --version` runs — two things the
 * sandbox refused a coding agent before the posture opened the network (F84,
 * F85) — and that a listener on the machine's loopback stays out of reach,
 * which is what the posture must never open. Measured on this machine, through
 * the spawn every coding agent and check takes, because what the sandbox
 * admits depends on the operating system and the toolchain it finds.
 *
 * A failure is reported, not fatal: the lane still serves files, commands and
 * `confined` folders, and the operator reads which probe failed and why.
 */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
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
 * Connections to a listener on the machine's loopback, its port the script's
 * argument: directly and through the sandbox's proxy, each by address and by
 * name. Prints what each attempt met, and exits 0 only when none reached it.
 */
export const MACHINE_LOOPBACK_REACH = [
  "const net = require('net');",
  "const http = require('http');",
  'const port = Number(process.argv[1]);',
  'const direct = (host) => new Promise((resolve) => {',
  '  const socket = net.connect(port, host);',
  "  socket.on('connect', () => { socket.destroy(); resolve('reached'); });",
  "  socket.on('error', (error) => resolve(error.code ?? 'refused'));",
  '});',
  'const proxied = (host) => new Promise((resolve) => {',
  '  const proxy = process.env.HTTP_PROXY ?? process.env.http_proxy;',
  "  if (proxy === undefined) { resolve('no proxy'); return; }",
  '  const url = new URL(proxy);',
  "  const headers = url.username === '' ? {} : { 'Proxy-Authorization': 'Basic ' +",
  "    Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64') };",
  "  const request = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: host + ':' + port, headers });",
  "  request.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode === 200 ? 'reached' : String(response.statusCode)); });",
  "  request.on('response', (response) => resolve(String(response.statusCode)));",
  "  request.on('error', (error) => resolve(error.code ?? 'refused'));",
  '  request.end();',
  '});',
  '(async () => {',
  '  const seen = {',
  "    directly: await direct('127.0.0.1'),",
  "    'directly by name': await direct('localhost'),",
  "    'through the proxy': await proxied('127.0.0.1'),",
  "    'through the proxy by name': await proxied('localhost'),",
  '  };',
  '  console.log(JSON.stringify(seen));',
  "  process.exit(Object.values(seen).includes('reached') ? 1 : 0);",
  '})();',
].join('\n');

/**
 * The shell probe writes its working directory to a file in the temporary
 * directory it is handed and removes it, as a coding agent's shell does after
 * every command. The loopback probe reaches for the port of a listener the
 * self-test holds outside the sandbox.
 */
export function openPostureProbes(machinePort: number): SelfTestProbe[] {
  const cwdFile = `${SELF_TEST_SCRATCH_PREFIX}${randomUUID()}-cwd`;
  return [
    {
      name: 'a shell command exits 0',
      argv: ['/bin/sh', '-c', 'pwd -P >"$TMPDIR/$1" && rm -f "$TMPDIR/$1"', 'sh', cwdFile],
    },
    { name: '`yarn --version` runs', argv: ['yarn', '--version'] },
    {
      name: "a listener on the machine's loopback is out of reach",
      argv: [process.execPath, '-e', MACHINE_LOOPBACK_REACH, String(machinePort)],
    },
  ];
}

/** Each probe under `open`, in a folder and checkout of the self-test's own. */
export async function runOpenPostureSelfTest(
  run: Spawn = runUnderFolderPosture,
): Promise<SelfTestOutcome[]> {
  const scratch = await mkdtemp(join(tmpdir(), SELF_TEST_SCRATCH_PREFIX));
  const machine = createServer((socket) => socket.end());
  try {
    machine.listen(0, '127.0.0.1');
    await once(machine, 'listening');
    const machinePort = (machine.address() as AddressInfo).port;
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
    for (const probe of openPostureProbes(machinePort)) {
      outcomes.push(await runProbe(run, probe, binding, checkout, scratch));
    }
    return outcomes;
  } finally {
    machine.close();
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
    log.info(
      "The open posture admits what a coding agent needs and keeps the machine's loopback " +
        'out of reach',
      { probes: outcomes.map((outcome) => outcome.name).join('; ') },
    );
    return;
  }
  for (const outcome of failed) {
    log.error(`Under the open posture, ${outcome.name} failed on this machine`, {
      detail: outcome.detail ?? 'no detail',
    });
  }
}
