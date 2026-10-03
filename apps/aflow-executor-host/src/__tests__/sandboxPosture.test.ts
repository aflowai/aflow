/**
 * Contract: what a coding agent and a folder's checks run under is the
 * folder's sandbox posture (Plan 315 D19). It is `open` unless the operator
 * chose `confined`, the policy file holds it only when they did, and
 * `host.binding.inspect` shows it either way. Both postures are the sandbox,
 * under one policy: `open` is Claude Code's sandbox with every domain allowed,
 * `confined` Codex CLI's workspace-write default, and neither lets a job read
 * or write the machine's host directory, write the operator's folder or its
 * `.git`, write `/tmp` or another job's scratch, or reach a listener on the
 * machine's loopback. A job writes the temporary directory it is handed, and
 * its loopback is its own on Linux and absent on macOS.
 *
 * The handler suites stand in for the spawn and record what it is handed; the
 * last suite runs a command under each posture for real, where this machine
 * can confine one.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOST_SANDBOX_POSTURE_DEFAULT,
  HostBindingInspectOutputSchema,
  type HostSandboxPosture,
} from '@aflow/schemas';

import type { SandboxedRunInput, SandboxedRunResult } from '../sandboxedRun.js';
import { CONFINEMENT_LISTENERS, requires } from './fixtures/capabilities.js';

const run = promisify(execFile);
const confinable = requires(...CONFINEMENT_LISTENERS);

const sandboxed: SandboxedRunInput[] = [];
let sandboxMissing = false;

function finished(processId: string): SandboxedRunResult {
  return {
    processId,
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 0,
    stdout: 'done',
    stderr: '',
    truncated: false,
  };
}

vi.mock('../sandboxedRun.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandboxedRun.js')>();
  return {
    ...actual,
    sandboxReadiness: () =>
      sandboxMissing
        ? { ready: false, missing: ['a sandbox mechanism for this operating system'] }
        : { ready: true, missing: [] },
    runSandboxed: (input: SandboxedRunInput): Promise<SandboxedRunResult> => {
      sandboxed.push(input);
      return Promise.resolve(finished('hr_sandboxed'));
    },
  };
});

const { HostPolicySchema, loadHostPolicy } = await import('../bindings.js');
const { createHostHarnessHandler } = await import('../handlers/harnessHandlers.js');
const { createHostHandler } = await import('../handlers/hostHandler.js');
const { noPushApprovals } = await import('./fixtures/pushApprovals.js');
const { serializePolicy, writePolicyAtomically } = await import('../policyFile.js');
const {
  describeSandboxPosture,
  keptSandboxPosture,
  sandboxPostureOf,
  sandboxVerb,
  withSandboxPosture,
} = await import('../sandboxPosture.js');
const actual = await vi.importActual<typeof import('../sandboxedRun.js')>('../sandboxedRun.js');
const { compileSandboxPolicy, FORBIDDEN_SANDBOX_OPTIONS } = await import('../sandboxPolicy.js');
const { workloadTemp } = await import('../baseEnv.js');
const { MACHINE_LOOPBACK_REACH, runOpenPostureSelfTest } =
  await import('../openPostureSelfTest.js');

/** Where the system keeps its temporary files, and on Linux every job's scratch. */
const SYSTEM_TEMP = '/tmp';

const RUNNING = {
  id: 'hb_app',
  root: '/tmp/app',
  mode: 'readwrite',
  allowsExecution: true,
  spaceId: 'space-a',
};
const FILES_ONLY = {
  id: 'hb_notes',
  root: '/tmp/notes',
  mode: 'read',
  allowsExecution: false,
  spaceId: 'space-a',
};

function policyWith(bindings: unknown[]) {
  return HostPolicySchema.parse({ version: 1, bindings });
}

beforeEach(() => {
  sandboxed.length = 0;
  sandboxMissing = false;
});

describe('the posture a folder holds', () => {
  it('is `open` for a folder that chose none, read so each time and never written in', async () => {
    const base = await mkdtemp(join(tmpdir(), 'sandbox-default-'));
    const policyPath = join(base, 'host-policy.json');
    await writeFile(policyPath, JSON.stringify({ version: 1, bindings: [RUNNING] }));
    const binding = (await loadHostPolicy(policyPath)).bindings.get('hb_app');
    expect(binding?.sandbox).toBeUndefined();
    expect(binding && sandboxPostureOf(binding)).toBe('open');
    expect(HOST_SANDBOX_POSTURE_DEFAULT).toBe('open');
    expect(serializePolicy(policyWith([RUNNING]))).not.toContain('sandbox');
  });

  it('is written for the folder it was chosen for, and for no other', async () => {
    const base = await mkdtemp(join(tmpdir(), 'sandbox-chosen-'));
    const policyPath = join(base, 'host-policy.json');
    const before = policyWith([RUNNING, { ...RUNNING, id: 'hb_other' }]);
    await writePolicyAtomically(
      policyPath,
      serializePolicy(withSandboxPosture(before, 'hb_app', 'confined')),
    );
    const written = JSON.parse(await readFile(policyPath, 'utf8')) as {
      bindings: Array<{ id: string; sandbox?: string }>;
    };
    expect(written.bindings.map((b) => [b.id, b.sandbox])).toEqual([
      ['hb_app', 'confined'],
      ['hb_other', undefined],
    ]);
    const reread = await loadHostPolicy(policyPath);
    expect(sandboxPostureOf(reread.bindings.get('hb_app') ?? {})).toBe('confined');
    expect(sandboxPostureOf(reread.bindings.get('hb_other') ?? {})).toBe('open');
  });

  it('refuses a folder this machine does not offer, one that runs no commands, and a posture outside the two', () => {
    const policy = policyWith([RUNNING, FILES_ONLY]);
    expect(() => withSandboxPosture(policy, 'hb_missing', 'open')).toThrow(
      'offers no folder `hb_missing`',
    );
    expect(() => withSandboxPosture(policy, 'hb_notes', 'confined')).toThrow('runs no commands');
    expect(() => withSandboxPosture(policy, 'hb_app', 'loose')).toThrow('open, confined');
  });

  it('survives a reconnect while the folder runs commands, and goes when it no longer does', () => {
    expect(keptSandboxPosture({ sandbox: 'confined' }, true)).toEqual({ sandbox: 'confined' });
    expect(keptSandboxPosture({ sandbox: 'confined' }, false)).toEqual({});
    expect(keptSandboxPosture({}, true)).toEqual({});
    expect(keptSandboxPosture(undefined, true)).toEqual({});
  });
});

describe('aflow harness sandbox <folder> open|confined', () => {
  it('sets the posture and says what the folder now runs under', () => {
    const confined = sandboxVerb(policyWith([RUNNING]), 'hb_app', ['confined']);
    expect(confined.policy.bindings[0]?.sandbox).toBe('confined');
    expect(confined.said).toBe(`\`hb_app\` now ${describeSandboxPosture('confined')}.`);

    const open = sandboxVerb(confined.policy, 'hb_app', ['open']);
    expect(open.policy.bindings[0]?.sandbox).toBe('open');
    expect(open.said).toContain('network open');
  });

  it('takes exactly one posture', () => {
    const policy = policyWith([RUNNING]);
    expect(() => sandboxVerb(policy, 'hb_app', [])).toThrow('Name one posture');
    expect(() => sandboxVerb(policy, 'hb_app', ['open', 'confined'])).toThrow('Name one posture');
  });
});

describe('host.binding.inspect', () => {
  let policyPath: string;

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'sandbox-inspect-'));
    policyPath = join(base, 'host-policy.json');
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [RUNNING, { ...RUNNING, id: 'hb_confined', sandbox: 'confined' }],
      }),
    );
  });

  async function inspect(bindingId: string): Promise<unknown> {
    let output: unknown;
    const result = await createHostHandler(policyPath, noPushApprovals).execute({
      operationId: 'host.binding.inspect',
      spaceId: 'space-a',
      runId: 'run-a',
      stepExecutionId: 'step-1',
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () => Promise.resolve({ bindingId }),
      writePayload: (_kind: string, data: unknown) => {
        output = data;
        return Promise.resolve('inline:out');
      },
    } as never);
    expect(result.status).toBe('SUCCEEDED');
    return output;
  }

  it('shows the posture a folder chose, and the default for one that chose none', async () => {
    expect(HostBindingInspectOutputSchema.parse(await inspect('hb_confined')).sandbox).toBe(
      'confined',
    );
    expect(HostBindingInspectOutputSchema.parse(await inspect('hb_app')).sandbox).toBe(
      HOST_SANDBOX_POSTURE_DEFAULT,
    );
  });
});

describe('a harness run under the folder’s posture', () => {
  let base: string;
  let repo: string;
  let policyPath: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'sandbox-harness-'));
    repo = join(base, 'project');
    await mkdir(repo, { recursive: true });
    const git = (...args: string[]) => run('git', ['-C', repo, ...args]);
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await writeFile(join(repo, 'README.md'), 'base\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'base');
    const folder = { ...RUNNING, root: repo, singleFile: false };
    policyPath = join(base, 'host-policy.json');
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [
          { ...folder, id: 'hb_default' },
          { ...folder, id: 'hb_open', sandbox: 'open' },
          { ...folder, id: 'hb_confined', sandbox: 'confined' },
        ],
        harnesses: [
          {
            id: 'agent',
            executable: '/bin/sh',
            args: ['-c', 'true'],
            configDirEnv: 'AGENT_CONFIG_DIR',
            credential: { command: ['/bin/echo', 'agent-credential'], env: 'AGENT_TOKEN' },
          },
        ],
      }),
    );
  });

  async function commission(bindingId: string) {
    return await createHostHarnessHandler(policyPath).execute({
      operationId: 'host.harness.run',
      spaceId: 'space-a',
      runId: `run-${bindingId}`,
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () => Promise.resolve({ bindingId, task: 'Do it.', timeoutMs: 60_000 }),
      emitLiveDelta: () => Promise.resolve(),
      writePayload: (kind: string) => Promise.resolve(`inline:${kind}`),
    } as never);
  }

  it('hands an `open` folder’s coding agent to the sandbox as `open`, in its checkout, with the lane’s environment', async () => {
    expect((await commission('hb_open')).status).toBe('SUCCEEDED');
    expect(sandboxed).toHaveLength(1);
    const input = sandboxed[0];
    expect(input?.posture).toBe('open');
    expect(input?.cwd.startsWith(tmpdir())).toBe(true);
    expect(input?.cwd).not.toBe(repo);
    expect(input?.env).toEqual({});
    expect(input?.trustedEnv).toMatchObject({
      SRT_DEBUG: '1',
      AGENT_TOKEN: 'agent-credential',
      AGENT_CONFIG_DIR: expect.stringContaining('harness-config'),
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
    });
    expect(input?.widening).toMatchObject({
      writableRoot: input?.cwd,
      withholdBindingWrite: true,
    });
  });

  it('hands a folder that chose none to the sandbox as `open`', async () => {
    expect((await commission('hb_default')).status).toBe('SUCCEEDED');
    expect(sandboxed.map((input) => input.posture)).toEqual(['open']);
  });

  it('hands a `confined` folder’s coding agent to the sandbox as `confined`', async () => {
    expect((await commission('hb_confined')).status).toBe('SUCCEEDED');
    expect(sandboxed.map((input) => input.posture)).toEqual(['confined']);
    expect(sandboxed[0]?.trustedEnv).toMatchObject({
      SRT_DEBUG: '1',
      AGENT_TOKEN: 'agent-credential',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
    });
  });

  it('refuses a coding agent under either posture on a machine with no qualified sandbox', async () => {
    sandboxMissing = true;
    expect((await commission('hb_open')).status).toBe('FAILED');
    expect((await commission('hb_confined')).status).toBe('FAILED');
    expect(sandboxed).toHaveLength(0);
  });
});

describe('what a posture compiles to', () => {
  const HOME = '/Users/probe';
  const HOST_DIR = join(HOME, '.aflow');
  const ROOT = join(HOME, 'projects', 'app');
  const SCRATCH = '/var/scratch/aflow-harness-x';
  const CHECKOUT = join(SCRATCH, 'work');

  function policyFor(posture: HostSandboxPosture) {
    return compileSandboxPolicy(
      { ...RUNNING, root: ROOT, singleFile: false, sandbox: posture } as never,
      {
        home: HOME,
        hostDir: HOST_DIR,
        scratchDir: SCRATCH,
        // A profile naming the host directory is given none of it.
        widening: {
          authPaths: [join(HOST_DIR, 'agent-auth')],
          writePaths: [HOST_DIR],
          allowedDomains: [],
          writableRoot: CHECKOUT,
          withholdBindingWrite: true,
        },
        toolPaths: [join(HOST_DIR, 'bin')],
      },
    );
  }

  const under = (paths: readonly string[], dir: string): string[] =>
    paths.filter((path) => path === dir || path.startsWith(`${dir}/`));

  it.each(['open', 'confined'] as const)(
    'withholds the host directory and the operator’s folder under `%s`',
    (posture) => {
      const policy = policyFor(posture);
      expect(policy.filesystem.denyRead).toContain(HOST_DIR);
      expect(policy.filesystem.denyWrite).toContain(HOST_DIR);
      expect(under(policy.filesystem.allowRead, HOST_DIR)).toEqual([]);
      expect(under(policy.filesystem.allowWrite, HOST_DIR)).toEqual([]);
      expect(under(policy.filesystem.allowWrite, ROOT)).toEqual([]);
      expect(policy.filesystem.allowRead).toContain(ROOT);
      expect(policy.filesystem.allowWrite).toEqual(expect.arrayContaining([SCRATCH, CHECKOUT]));
    },
  );

  it('is one policy under both, which grants the machine’s loopback under neither', () => {
    const open = policyFor('open');
    expect(open).toEqual(policyFor('confined'));
    expect(open.network).toEqual({ allowedDomains: [], deniedDomains: [] });
    const serialized = JSON.stringify(open);
    for (const option of FORBIDDEN_SANDBOX_OPTIONS) {
      expect(serialized).not.toContain(option);
    }
  });

  it.each(['open', 'confined'] as const)(
    'writes its own temporary directory under `%s`, and neither /tmp nor a concurrent job’s scratch there',
    (posture) => {
      // On Linux the system temporary directory holds every job's scratch, and
      // a folder may live there too.
      const ownScratch = join(SYSTEM_TEMP, 'aflow-harness-own');
      const otherScratch = join(SYSTEM_TEMP, 'aflow-check-other');
      const root = join(SYSTEM_TEMP, 'app');
      const policy = compileSandboxPolicy(
        { ...RUNNING, root, singleFile: false, sandbox: posture } as never,
        {
          home: HOME,
          hostDir: HOST_DIR,
          scratchDir: ownScratch,
          widening: {
            authPaths: [],
            allowedDomains: [],
            writableRoot: join(ownScratch, 'work'),
            withholdBindingWrite: true,
          },
        },
      );
      const writable = (path: string): boolean =>
        policy.filesystem.allowWrite.some(
          (granted) => path === granted || path.startsWith(`${granted}/`),
        );
      expect(writable(workloadTemp(ownScratch))).toBe(true);
      for (const refused of [
        join(SYSTEM_TEMP, 'anything'),
        join(otherScratch, 'work', 'README.md'),
        join(otherScratch, 'srt-settings.json'),
        join(root, 'README.md'),
      ]) {
        expect(writable(refused), refused).toBe(false);
      }
    },
  );
});

/**
 * Each attempt a job could make on what the gates read, the operator owns or
 * another job holds, and the two writes a coding agent needs. Run as `node -e`
 * with the host directory, the folder, the checkout, a path in the system
 * temporary directory and a concurrent job's scratch as its arguments.
 */
const ATTEMPTS = [
  "const fs = require('fs');",
  "const path = require('path');",
  'const [hostDir, root, checkout, tempProbe, otherScratch] = process.argv.slice(1);',
  'const attempts = {',
  "  'rewrite the host policy': () => fs.writeFileSync(path.join(hostDir, 'host-policy.json'), '{}'),",
  "  'read the pairing credential': () => fs.readFileSync(path.join(hostDir, 'host.env'), 'utf8'),",
  "  'write the operator’s folder': () => fs.writeFileSync(path.join(root, 'README.md'), 'changed'),",
  "  'plant a hook in its .git': () => fs.writeFileSync(path.join(root, '.git', 'hooks', 'post-checkout'), '#!/bin/sh'),",
  "  'move a branch in its .git': () => fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), '0'.repeat(40)),",
  "  'write the checkout': () => fs.writeFileSync(path.join(checkout, 'made-by-the-agent.txt'), 'ok'),",
  "  'write the system temp root': () => { fs.writeFileSync(tempProbe, 'ok'); fs.rmSync(tempProbe); },",
  "  'rewrite another job’s sandbox settings': () => fs.writeFileSync(path.join(otherScratch, 'srt-settings.json'), '{}'),",
  "  'write another job’s checkout': () => fs.writeFileSync(path.join(otherScratch, 'work', 'made-by-the-agent.txt'), 'ok'),",
  "  'write its own temporary directory': () => fs.writeFileSync(path.join(require('os').tmpdir(), 'made-by-the-agent.txt'), 'ok'),",
  '};',
  'const seen = {};',
  'for (const [name, attempt] of Object.entries(attempts)) {',
  "  try { attempt(); seen[name] = 'done'; } catch { seen[name] = 'refused'; }",
  '}',
  'console.log(JSON.stringify(seen));',
].join('\n');

const CAN_CONFINE = actual.sandboxAvailable() && !confinable.skip;

describe.each(['open', 'confined'] as const)('a command under `%s`, for real', (posture) => {
  const saved = {
    dir: process.env['PHOENIX_HOST_DIR'],
    path: process.env['PHOENIX_HOST_POLICY_PATH'],
  };
  afterEach(() => {
    for (const [key, value] of [
      ['PHOENIX_HOST_DIR', saved.dir],
      ['PHOENIX_HOST_POLICY_PATH', saved.path],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.skipIf(!CAN_CONFINE)(
    confinable.title(
      'reaches neither the machine’s trust configuration, the operator’s folder, /tmp nor another job’s scratch',
    ),
    { tags: ['listener'] },
    async () => {
      const base = await mkdtemp(join(tmpdir(), 'posture-invariant-'));
      const hostDir = join(base, 'host');
      const root = join(base, 'folder');
      const scratchDir = join(base, 'scratch');
      const checkout = join(scratchDir, 'work');
      for (const dir of [
        hostDir,
        join(root, '.git', 'hooks'),
        join(root, '.git', 'refs', 'heads'),
      ]) {
        await mkdir(dir, { recursive: true });
      }
      await mkdir(checkout, { recursive: true });
      // A concurrent job's scratch, made where the executor makes every job's.
      const otherScratch = await mkdtemp(join(tmpdir(), 'posture-other-job-'));
      await mkdir(join(otherScratch, 'work'));
      const otherSettings = JSON.stringify({ network: { allowedDomains: [] } });
      await writeFile(join(otherScratch, 'srt-settings.json'), otherSettings);
      const policyText = JSON.stringify({ version: 1, bindings: [] });
      await writeFile(join(hostDir, 'host-policy.json'), policyText);
      await writeFile(join(hostDir, 'host.env'), 'REDIS_URL=redis://:paired@localhost:6379\n');
      await writeFile(join(root, 'README.md'), 'the operator’s\n');
      process.env['PHOENIX_HOST_DIR'] = hostDir;
      delete process.env['PHOENIX_HOST_POLICY_PATH'];

      const tempProbe = join(SYSTEM_TEMP, `posture-invariant-${String(process.pid)}`);
      const result = await actual.runSandboxed({
        binding: { ...RUNNING, root, singleFile: false, sandbox: posture } as never,
        posture,
        argv: [process.execPath, '-e', ATTEMPTS, hostDir, root, checkout, tempProbe, otherScratch],
        cwd: checkout,
        env: {},
        timeoutMs: 60_000,
        scratchDir,
        widening: {
          authPaths: [],
          allowedDomains: [],
          writableRoot: checkout,
          withholdBindingWrite: true,
        },
        idPrefix: 'hr',
        ownerRunId: 'run-invariant',
        signal: new AbortController().signal,
        closeStdin: true,
        onDelta: () => undefined,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const last = result.stdout.trim().split('\n').at(-1) ?? '{}';
      expect(JSON.parse(last)).toEqual({
        'rewrite the host policy': 'refused',
        'read the pairing credential': 'refused',
        'write the operator’s folder': 'refused',
        'plant a hook in its .git': 'refused',
        'move a branch in its .git': 'refused',
        'write the checkout': 'done',
        'write the system temp root': 'refused',
        'rewrite another job’s sandbox settings': 'refused',
        'write another job’s checkout': 'refused',
        'write its own temporary directory': 'done',
      });
      expect(existsSync(join(workloadTemp(scratchDir), 'made-by-the-agent.txt'))).toBe(true);
      expect(await readFile(join(otherScratch, 'srt-settings.json'), 'utf8')).toBe(otherSettings);
      expect(existsSync(join(otherScratch, 'work', 'made-by-the-agent.txt'))).toBe(false);
      expect(await readFile(join(hostDir, 'host-policy.json'), 'utf8')).toBe(policyText);
      expect(existsSync(join(root, '.git', 'hooks', 'post-checkout'))).toBe(false);
    },
  );
});

/** A documentation-only address: off this machine, and answered by nobody. */
const OFF_MACHINE = '192.0.2.1:9';

/**
 * Long enough for the sandbox's proxy to refuse a host, which it does before
 * dialling; one it admits is still being dialled when this runs out.
 */
const PROXY_ANSWER_DEADLINE_MS = 2_000;

/**
 * A server the job binds on its own loopback and a connection to it, then a
 * connection through the sandbox's proxy to a host off the machine, run as
 * `node -e` with that host and the deadline as its arguments. The proxy's own
 * refusal carries `X-Proxy-Error`; anything else means it let the job through.
 */
const OWN_LOOPBACK_AND_NETWORK = [
  "const net = require('net');",
  "const http = require('http');",
  'const [offMachine, deadlineMs] = process.argv.slice(1);',
  'const own = () => new Promise((resolve) => {',
  "  const server = net.createServer((socket) => socket.end('pong'));",
  "  server.on('error', (error) => resolve(error.code ?? 'refused'));",
  "  server.listen(0, '127.0.0.1', () => {",
  "    net.connect(server.address().port, '127.0.0.1')",
  "      .on('data', () => { server.close(); resolve('reached'); })",
  "      .on('error', (error) => { server.close(); resolve(error.code ?? 'refused'); });",
  '  });',
  '});',
  'const network = () => new Promise((resolve) => {',
  '  const proxy = process.env.HTTP_PROXY ?? process.env.http_proxy;',
  "  if (proxy === undefined) { resolve('no proxy'); return; }",
  '  const url = new URL(proxy);',
  "  const headers = url.username === '' ? {} : { 'Proxy-Authorization': 'Basic ' +",
  "    Buffer.from(decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64') };",
  "  const answer = (response) => resolve(response.headers['x-proxy-error'] === undefined ? 'admitted' : 'refused');",
  "  const request = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: offMachine, headers });",
  "  request.on('connect', (response, socket) => { socket.destroy(); answer(response); });",
  "  request.on('response', answer);",
  "  request.on('error', (error) => resolve(error.code ?? 'refused'));",
  "  setTimeout(() => resolve('admitted'), Number(deadlineMs)).unref();",
  '  request.end();',
  '});',
  '(async () => {',
  "  console.log(JSON.stringify({ 'its own server': await own(), 'a host off the machine': await network() }));",
  '  process.exit(0);',
  '})();',
].join('\n');

/** What a job has on loopback when the sandbox keeps the machine's: its own on Linux, none on macOS. */
const OWN_LOOPBACK = process.platform === 'linux' ? 'reached' : 'EPERM';

describe.each([
  ['open', 'admitted'],
  ['confined', 'refused'],
] as const)('the network under `%s`, for real', (posture, offMachine) => {
  async function runUnder(argv: string[]): Promise<SandboxedRunResult> {
    const base = await mkdtemp(join(tmpdir(), 'posture-network-'));
    const root = join(base, 'folder');
    const scratchDir = join(base, 'scratch');
    const checkout = join(scratchDir, 'work');
    await mkdir(root, { recursive: true });
    await mkdir(checkout, { recursive: true });
    return await actual.runSandboxed({
      binding: { ...RUNNING, root, singleFile: false, sandbox: posture } as never,
      posture,
      argv,
      cwd: checkout,
      env: {},
      timeoutMs: 60_000,
      scratchDir,
      widening: {
        authPaths: [],
        allowedDomains: [],
        writableRoot: checkout,
        withholdBindingWrite: true,
      },
      idPrefix: 'hr',
      ownerRunId: 'run-network',
      signal: new AbortController().signal,
      closeStdin: true,
      onDelta: () => undefined,
    });
  }

  const lastLine = (result: SandboxedRunResult): unknown =>
    JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');

  it.skipIf(!CAN_CONFINE)(
    confinable.title(
      'reaches no listener on the machine’s loopback, directly or through the proxy, by address or by name',
    ),
    { tags: ['listener'] },
    async () => {
      const machine = createServer((socket) => socket.end('+PONG\r\n'));
      await new Promise<void>((resolve) => machine.listen(0, '127.0.0.1', resolve));
      const { port } = machine.address() as AddressInfo;
      try {
        const result = await runUnder([
          process.execPath,
          '-e',
          MACHINE_LOOPBACK_REACH,
          String(port),
        ]);
        expect(result.exitCode, result.stdout + result.stderr).toBe(0);
        const seen = lastLine(result) as Record<string, string>;
        expect(Object.keys(seen)).toEqual([
          'directly',
          'directly by name',
          'through the proxy',
          'through the proxy by name',
        ]);
        expect(Object.values(seen)).not.toContain('reached');
      } finally {
        machine.close();
      }
    },
  );

  it.skipIf(!CAN_CONFINE)(
    confinable.title(
      `has its own loopback only on Linux, and ${offMachine === 'admitted' ? 'reaches' : 'does not reach'} a host off the machine`,
    ),
    { tags: ['listener'] },
    async () => {
      const result = await runUnder([
        process.execPath,
        '-e',
        OWN_LOOPBACK_AND_NETWORK,
        OFF_MACHINE,
        String(PROXY_ANSWER_DEADLINE_MS),
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(lastLine(result)).toEqual({
        'its own server': OWN_LOOPBACK,
        'a host off the machine': offMachine,
      });
    },
  );
});

describe('the boot self-test of the `open` posture', { tags: ['listener'] }, () => {
  it('runs each probe in a folder of its own, under `open`, writing only its checkout', async () => {
    const outcomes = await runOpenPostureSelfTest();
    expect(outcomes.map((outcome) => outcome.name)).toEqual([
      'a shell command exits 0',
      '`yarn --version` runs',
      "a listener on the machine's loopback is out of reach",
    ]);
    expect(outcomes.every((outcome) => outcome.passed)).toBe(true);
    expect(sandboxed.map((input) => input.posture)).toEqual(['open', 'open', 'open']);
    for (const input of sandboxed) {
      expect(input.widening).toMatchObject({
        writableRoot: input.cwd,
        withholdBindingWrite: true,
      });
    }
    expect(sandboxed[0]?.argv[0]).toBe('/bin/sh');
    expect(sandboxed[0]?.argv[2]).toContain('"$TMPDIR/$1"');
    expect(sandboxed[1]?.argv).toEqual(['yarn', '--version']);
    expect(sandboxed[2]?.argv.slice(0, 3)).toEqual([
      process.execPath,
      '-e',
      MACHINE_LOOPBACK_REACH,
    ]);
    expect(Number(sandboxed[2]?.argv[3])).toBeGreaterThan(0);
  });

  it('names a probe that failed and what it said', async () => {
    const outcomes = await runOpenPostureSelfTest((input) =>
      Promise.resolve({
        ...finished('st_probe'),
        ...(input.argv[0] === 'yarn'
          ? { exitCode: 1, stdout: '', stderr: 'Corepack could not fetch Yarn' }
          : {}),
      }),
    );
    expect(outcomes.filter((outcome) => !outcome.passed)).toEqual([
      {
        name: '`yarn --version` runs',
        passed: false,
        detail: 'exited 1: Corepack could not fetch Yarn',
      },
    ]);
  });

  it.skipIf(!CAN_CONFINE)(
    confinable.title(
      'finds a shell command working and the machine’s loopback out of reach under `open`, for real',
    ),
    async () => {
      const outcomes = await runOpenPostureSelfTest(
        async (input) => await actual.runSandboxed({ ...input, posture: 'open' }),
      );
      const byName = new Map(outcomes.map((outcome) => [outcome.name, outcome]));
      for (const name of [
        'a shell command exits 0',
        "a listener on the machine's loopback is out of reach",
      ]) {
        expect(byName.get(name)).toEqual({ name, passed: true });
      }
    },
  );
});
