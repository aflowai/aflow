/**
 * Contract: what a coding agent and a folder's checks run under is the
 * folder's sandbox posture (Plan 315 D19). It is `open` unless the operator
 * chose `confined`, the policy file holds it only when they did, and
 * `host.binding.inspect` shows it either way. A harness run in an `open`
 * folder is spawned unconfined with the environment the lane assembles; in a
 * `confined` one it is handed to the sandbox as before.
 *
 * The handler suites stand in for both spawns and record what each is handed;
 * the last suite spawns an `open` run for real.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOST_SANDBOX_POSTURE_DEFAULT, HostBindingInspectOutputSchema } from '@aflow/schemas';

import type { SandboxedRunInput, SandboxedRunResult } from '../sandboxedRun.js';
import { LOOPBACK_LISTENER, requires } from './fixtures/capabilities.js';

const run = promisify(execFile);
const listens = requires(LOOPBACK_LISTENER);

const sandboxed: SandboxedRunInput[] = [];
const opened: SandboxedRunInput[] = [];
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
      return Promise.resolve(finished('hr_confined'));
    },
    runOpen: (input: SandboxedRunInput): Promise<SandboxedRunResult> => {
      opened.push(input);
      return Promise.resolve(finished('hr_open'));
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
  opened.length = 0;
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
    expect(open.said).toContain('unconfined');
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

  it('spawns an `open` folder’s coding agent unconfined, in its checkout, with the lane’s environment', async () => {
    expect((await commission('hb_open')).status).toBe('SUCCEEDED');
    expect(sandboxed).toHaveLength(0);
    expect(opened).toHaveLength(1);
    const input = opened[0];
    expect(input?.cwd.startsWith(tmpdir())).toBe(true);
    expect(input?.cwd).not.toBe(repo);
    expect(input?.env).toEqual({});
    expect(input?.trustedEnv).toMatchObject({
      AGENT_TOKEN: 'agent-credential',
      AGENT_CONFIG_DIR: expect.stringContaining('harness-config'),
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
    });
    expect(input?.trustedEnv).not.toHaveProperty('SRT_DEBUG');
  });

  it('spawns a folder that chose none as `open`', async () => {
    expect((await commission('hb_default')).status).toBe('SUCCEEDED');
    expect(sandboxed).toHaveLength(0);
    expect(opened).toHaveLength(1);
  });

  it('hands a `confined` folder’s coding agent to the sandbox, as before', async () => {
    expect((await commission('hb_confined')).status).toBe('SUCCEEDED');
    expect(opened).toHaveLength(0);
    expect(sandboxed).toHaveLength(1);
    const input = sandboxed[0];
    expect(input?.trustedEnv).toMatchObject({
      SRT_DEBUG: '1',
      AGENT_TOKEN: 'agent-credential',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
    });
    expect(input?.widening).toMatchObject({
      writableRoot: input?.cwd,
      withholdBindingWrite: true,
    });
  });

  it('runs an `open` folder on a machine with no qualified sandbox, and refuses a `confined` one there', async () => {
    sandboxMissing = true;
    expect((await commission('hb_open')).status).toBe('SUCCEEDED');
    expect((await commission('hb_confined')).status).toBe('FAILED');
    expect(sandboxed).toHaveLength(0);
  });
});

describe('an `open` spawn', () => {
  async function openRun(script: string, trustedEnv: Record<string, string> = {}) {
    const scratchDir = await mkdtemp(join(tmpdir(), 'open-run-'));
    const root = await mkdtemp(join(tmpdir(), 'open-folder-'));
    const binding = HostPolicySchema.parse({
      version: 1,
      bindings: [{ ...RUNNING, root, sandbox: 'open' }],
    }).bindings[0];
    if (binding === undefined) throw new Error('no binding');
    const result = await actual.runOpen({
      binding,
      argv: [process.execPath, '-e', script],
      cwd: root,
      env: {},
      trustedEnv,
      timeoutMs: 30_000,
      scratchDir,
      idPrefix: 'hr',
      ownerRunId: 'run-open',
      signal: new AbortController().signal,
      closeStdin: true,
      onDelta: () => undefined,
    });
    return { result, scratchDir, root };
  }

  it('runs as the operator, writes the folder, and sees only the environment the lane assembled', async () => {
    process.env['AFLOW_EXECUTOR_ONLY'] = 'not for the workload';
    try {
      const { result, scratchDir, root } = await openRun(
        [
          "require('fs').writeFileSync('written-by-the-agent.txt', 'ok');",
          'console.log(JSON.stringify({',
          '  uid: process.getuid(),',
          "  home: process.env['HOME'],",
          "  tmp: process.env['TMPDIR'],",
          "  token: process.env['AGENT_TOKEN'],",
          "  executorOnly: process.env['AFLOW_EXECUTOR_ONLY'] ?? null,",
          '}));',
        ].join('\n'),
        { AGENT_TOKEN: 'agent-credential' },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        uid: process.getuid?.(),
        home: join(scratchDir, 'home'),
        tmp: scratchDir,
        token: 'agent-credential',
        executorOnly: null,
      });
      expect(existsSync(join(root, 'written-by-the-agent.txt'))).toBe(true);
    } finally {
      delete process.env['AFLOW_EXECUTOR_ONLY'];
    }
  });

  it.skipIf(listens.skip)(
    listens.title('reaches the machine’s loopback, which is simply the machine’s'),
    async () => {
      const machine = createServer((socket) => socket.end('pong'));
      await new Promise<void>((resolve) => machine.listen(0, '127.0.0.1', resolve));
      const { port } = machine.address() as AddressInfo;
      try {
        const { result } = await openRun(
          [
            `require('net').connect(${String(port)}, '127.0.0.1')`,
            "  .on('data', (data) => { console.log('machine ' + data); process.exit(0); })",
            "  .on('error', (error) => { console.log('machine ' + error.code); process.exit(1); });",
          ].join('\n'),
        );
        expect(result.stdout.trim()).toBe('machine pong');
      } finally {
        machine.close();
      }
    },
  );
});
