/**
 * Contract: `host.commit.check` runs the folder's declared checks — and only
 * those — in a detached checkout of the commit, with the commit and its base in
 * the environment, under the folder's time; it answers whether they passed with
 * the end of what they printed, stores the whole, and leaves no checkout
 * behind — only a receipt of the outcome for the push, holding none of the
 * output. A folder that declares none is answered without anything running.
 *
 * The suites over the handler stand in for the sandbox with a spawn of their
 * own, recording what the handler hands it — the boundary itself is held by
 * the sandbox's own tests, and a nested sandbox cannot start under one. The
 * last suite runs a check through the real sandbox where this machine can.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOST_CHECK_OUTPUT_TAIL_BYTES,
  HOST_CHECK_TAIL_BYTES,
  HostCommitCheckOutputSchema,
} from '@aflow/schemas';

import type { SandboxedRunInput, SandboxedRunResult } from '../sandboxedRun.js';
import {
  compileSandboxPolicy,
  OPEN_ONLY_SANDBOX_OPTION,
  SYSTEM_TEMP_ROOT,
} from '../sandboxPolicy.js';
import { CONFINEMENT_LISTENERS, requires } from './fixtures/capabilities.js';

const confined = requires(...CONFINEMENT_LISTENERS);

const run = promisify(execFile);

/** The stand-in's clock runs this many times faster than the one it is handed. */
const CLOCK_SPEEDUP = 1000;

const handed: SandboxedRunInput[] = [];
let realSandbox = false;
let sandboxMissing = false;

vi.mock('../sandboxedRun.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandboxedRun.js')>();
  return {
    ...actual,
    sandboxReadiness: () => {
      if (realSandbox) return actual.sandboxReadiness();
      return sandboxMissing
        ? { ready: false, missing: ['a sandbox mechanism for this operating system'] }
        : { ready: true, missing: [] };
    },
    runSandboxed: async (input: SandboxedRunInput): Promise<SandboxedRunResult> => {
      if (realSandbox) return await actual.runSandboxed(input);
      handed.push(input);
      const [program, ...args] = input.argv;
      const startedAt = Date.now();
      return await new Promise((resolve) => {
        const child = spawn(program ?? '', args, {
          cwd: input.cwd,
          env: { PATH: process.env['PATH'] ?? '', ...input.env, ...input.trustedEnv },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          input.onDelta(chunk.toString());
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
          input.onDelta(chunk.toString());
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, input.timeoutMs / CLOCK_SPEEDUP);
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          resolve({
            processId: 'hc_test',
            exitCode: code,
            signal,
            timedOut,
            durationMs: Date.now() - startedAt,
            stdout,
            stderr,
            truncated: false,
          });
        });
      });
    },
  };
});

const { createHostHandler } = await import('../handlers/hostHandler.js');
const { noPushApprovals } = await import('./fixtures/pushApprovals.js');
const { checkTail, createHeadTailBuffer, createTailBuffer, utf8Suffix } =
  await import('../commitCheck.js');
const { requireCheckedPush } = await import('../checkReceipt.js');
const actualSandbox =
  await vi.importActual<typeof import('../sandboxedRun.js')>('../sandboxedRun.js');

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', cwd, ...args])).stdout;
}

/** A node one-liner as a check, so the fixture needs no program but the one running this. */
function nodeCheck(script: string): string[] {
  return [process.execPath, '-e', script];
}

/** Prints what the check saw: where it ran, the two shas, and a file only the checked commit holds. */
const REPORTING = nodeCheck(
  [
    "const fs = require('fs');",
    'console.log(JSON.stringify({',
    '  cwd: process.cwd(),',
    "  sha: process.env['AFLOW_CHECK_SHA'],",
    "  base: process.env['AFLOW_CHECK_BASE'],",
    "  added: fs.existsSync('added.txt') ? fs.readFileSync('added.txt', 'utf8') : null,",
    '}));',
  ].join('\n'),
);

const FAILING = nodeCheck(
  "console.log('step one ok'); console.error('FAIL tsc packages/x/tsconfig.json'); process.exit(3);",
);

const HANGING = nodeCheck('setTimeout(() => {}, 60_000);');

/**
 * A server of its own on loopback; then the machine's listener on `machinePort`,
 * standing in for the stack's Redis; then a documentation-only address, which
 * only closed egress refuses at once. Each line says what it reached.
 */
function loopbackAndEgress(machinePort: number): string[] {
  return nodeCheck(
    [
      "const net = require('net');",
      'const reach = (label, port, host, next) => net.connect(port, host)',
      "  .on('data', (data) => { console.log(label + ' ' + data); next(); })",
      "  .on('error', (error) => { console.log(label + ' ' + error.code); next(); });",
      "const server = net.createServer((socket) => socket.end('pong'));",
      'const beyond = () => {',
      `  reach('machine', ${String(machinePort)}, '127.0.0.1', () =>`,
      "    reach('egress', 80, '192.0.2.1', () => process.exit(0)));",
      '};',
      "server.on('error', (error) => { console.log('own ' + error.code); beyond(); });",
      "server.listen(0, '127.0.0.1', () =>",
      "  reach('own', server.address().port, '127.0.0.1', () => { server.close(); beyond(); }));",
    ].join('\n'),
  );
}

interface Fixture {
  readonly repo: string;
  readonly base: string;
  readonly sha: string;
  readonly policyPath: string;
}

async function fixture(
  branchPolicy: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'commit-check-'));
  const repo = join(dir, 'repo');
  await run('git', ['init', '-q', '-b', 'main', repo]);
  await git(repo, 'config', 'user.email', 't@e.com');
  await git(repo, 'config', 'user.name', 'T');
  await writeFile(join(repo, 'README.md'), 'base\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'base');
  const base = (await git(repo, 'rev-parse', 'HEAD')).trim();
  await writeFile(join(repo, 'added.txt'), 'only in the checked commit\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'change');
  const sha = (await git(repo, 'rev-parse', 'HEAD')).trim();
  // The folder's own HEAD is elsewhere, so a check that ran in it would not see the change.
  await git(repo, 'checkout', '-q', '--detach', base);

  const policyPath = join(dir, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb_app',
          root: repo,
          mode: 'readwrite',
          allowsExecution: true,
          spaceId: 'space-a',
          ...(branchPolicy !== undefined ? { branchPolicy } : {}),
          ...extra,
        },
      ],
    }),
  );
  return { repo, base, sha, policyPath };
}

interface Captured {
  output?: unknown;
  payloads: Array<{ kind: string; data: unknown }>;
  deltas: string[];
}

function contextFor(input: unknown, captured: Captured): never {
  return {
    operationId: 'host.commit.check',
    spaceId: 'space-a',
    runId: 'run-a',
    stepExecutionId: 'step-1',
    tenantId: 'tenant-a',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () => Promise.resolve(input),
    emitLiveDelta: (_channel: string, text: string) => {
      captured.deltas.push(text);
      return Promise.resolve();
    },
    writePayload: (kind: string, data: unknown) => {
      captured.payloads.push({ kind, data });
      if (kind === 'output' || kind === 'error') captured.output = data;
      return Promise.resolve(`inline:${kind}`);
    },
  } as never;
}

async function check(world: Fixture, input: Record<string, unknown> = {}) {
  const captured: Captured = { payloads: [], deltas: [] };
  const result = await createHostHandler(world.policyPath, noPushApprovals).execute(
    contextFor({ bindingId: 'hb_app', sha: world.sha, base: world.base, ...input }, captured),
  );
  return { result, captured };
}

async function checkouts(repo: string): Promise<string> {
  return await git(repo, 'worktree', 'list', '--porcelain');
}

beforeEach(() => {
  handed.length = 0;
  realSandbox = false;
  sandboxMissing = false;
});

describe('host.commit.check — a passing check', () => {
  let world: Fixture;
  beforeAll(async () => {
    world = await fixture({ branchPrefix: 'aflow/', checks: REPORTING });
  });

  it('runs the declared argv in a checkout of the commit, with the commit and its base in its environment', async () => {
    const { result, captured } = await check(world, {
      sha: world.sha.slice(0, 12),
      base: world.base.slice(0, 12),
    });
    expect(result.status).toBe('SUCCEEDED');
    const output = HostCommitCheckOutputSchema.parse(captured.output);
    expect(output).toMatchObject({
      passed: true,
      exitCode: 0,
      checks: REPORTING,
      clearedSha: world.sha,
      outputRef: 'inline:logs',
    });
    expect(output.skipped).toBeUndefined();
    const seen = JSON.parse(output.tail) as Record<string, unknown>;
    expect(seen['sha']).toBe(world.sha);
    expect(seen['base']).toBe(world.base);
    expect(seen['added']).toBe('only in the checked commit\n');
    expect(String(seen['cwd'])).not.toBe(world.repo);
    expect(output.summary).toContain('passed');
  });

  it('confines it as a coding agent is confined: no egress, the checkout writable and the folder not', async () => {
    await check(world);
    const input = handed[0];
    expect(input?.argv).toEqual(REPORTING);
    expect(input?.widening).toEqual({
      authPaths: [],
      allowedDomains: [],
      writableRoot: input?.cwd,
      withholdBindingWrite: true,
    });
    expect(input?.trustedEnv).toMatchObject({
      AFLOW_CHECK_SHA: world.sha,
      AFLOW_CHECK_BASE: world.base,
      GIT_NO_REPLACE_OBJECTS: '1',
    });
  });

  it('removes the checkout and its scratch afterwards, and leaves the folder where it was', async () => {
    const head = (await git(world.repo, 'rev-parse', 'HEAD')).trim();
    const { captured } = await check(world);
    const { cwd } = JSON.parse(HostCommitCheckOutputSchema.parse(captured.output).tail) as {
      cwd: string;
    };
    expect(existsSync(cwd)).toBe(false);
    expect(existsSync(join(cwd, '..'))).toBe(false);
    expect(await checkouts(world.repo)).not.toContain(cwd);
    expect((await git(world.repo, 'rev-parse', 'HEAD')).trim()).toBe(head);
  });

  it('stores what it printed and streams it as it comes', async () => {
    const { captured } = await check(world);
    const stored = captured.payloads.find((p) => p.kind === 'logs');
    expect(String(stored?.data)).toContain(world.sha);
    expect(captured.deltas.join('')).toContain(world.sha);
  });

  it('refuses a commit the folder does not hold, naming it', async () => {
    const { result, captured } = await check(world, { sha: 'f'.repeat(40) });
    expect(result.status).toBe('FAILED');
    expect(JSON.stringify(captured.output)).toContain('f'.repeat(40));
    expect(handed).toHaveLength(0);
  });
});

describe('host.commit.check — a failing check', () => {
  let world: Fixture;
  beforeAll(async () => {
    world = await fixture({ branchPrefix: 'aflow/', checks: FAILING });
  });

  it('answers that it failed, with its exit, the end of what it printed and no cleared commit', async () => {
    const { result, captured } = await check(world);
    expect(result.status).toBe('SUCCEEDED');
    const output = HostCommitCheckOutputSchema.parse(captured.output);
    expect(output.passed).toBe(false);
    expect(output.exitCode).toBe(3);
    expect(output.clearedSha).toBeUndefined();
    expect(output.tail).toContain('step one ok');
    expect(output.tail).toContain('FAIL tsc packages/x/tsconfig.json');
    expect(output.summary).toContain('exited 3');
    expect(output.summary).toContain('FAIL tsc packages/x/tsconfig.json');
    expect(captured.payloads.find((p) => p.kind === 'logs')?.data).toContain('FAIL tsc');
  });

  it('removes the checkout after a failure as after a pass', async () => {
    const before = await checkouts(world.repo);
    await check(world);
    expect(await checkouts(world.repo)).toBe(before);
  });
});

describe('host.commit.check — the folder’s time', () => {
  it('stops a check still running when the folder’s time runs out, and fails it naming the knob', async () => {
    const world = await fixture({
      branchPrefix: 'aflow/',
      checks: HANGING,
      checksTimeoutMs: 60_000,
    });
    const before = await checkouts(world.repo);
    const { result, captured } = await check(world);
    expect(handed[0]?.timeoutMs).toBe(60_000);
    expect(result.status).toBe('SUCCEEDED');
    const output = HostCommitCheckOutputSchema.parse(captured.output);
    expect(output).toMatchObject({ passed: false, timedOut: true, exitCode: null });
    expect(output.clearedSha).toBeUndefined();
    expect(output.summary).toContain('`checksTimeoutMs`, 1 min');
    expect(output.summary).toContain('aflow harness checks hb_app --timeout-minutes');
    expect(await checkouts(world.repo)).toBe(before);
  });
});

describe('host.commit.check — a folder that declares none', () => {
  it('answers passed and skipped, saying why, with nothing run and no checkout made', async () => {
    const world = await fixture({ branchPrefix: 'aflow/' });
    const before = await checkouts(world.repo);
    const { result, captured } = await check(world);
    expect(result.status).toBe('SUCCEEDED');
    const output = HostCommitCheckOutputSchema.parse(captured.output);
    expect(output).toMatchObject({
      passed: true,
      skipped: true,
      exitCode: null,
      tail: '',
      clearedSha: world.sha,
    });
    expect(output.outputRef).toBeUndefined();
    expect(output.summary).toContain('declares no checks, so none ran');
    expect(output.summary).toContain('aflow harness checks hb_app --');
    expect(handed).toHaveLength(0);
    expect(await checkouts(world.repo)).toBe(before);
  });

  it('answers the same for a folder that pushes nothing', async () => {
    const world = await fixture(undefined);
    const { captured } = await check(world);
    expect(HostCommitCheckOutputSchema.parse(captured.output).skipped).toBe(true);
  });

  it('issues no receipt, since a push from it needs none', async () => {
    const world = await fixture({ branchPrefix: 'aflow/' });
    const { captured } = await check(world);
    expect(HostCommitCheckOutputSchema.parse(captured.output).receipt).toBeUndefined();
  });
});

describe('host.commit.check — the receipt it leaves for the push', () => {
  /** What a receipt's body says, read without its signature. */
  function receiptBody(receipt: string): string {
    return Buffer.from(receipt.split('.')[0] ?? '', 'base64url').toString('utf8');
  }

  it('says the checks passed on exactly this commit, against this base, as declared', async () => {
    const world = await fixture({ branchPrefix: 'aflow/', checks: REPORTING });
    const { captured } = await check(world);
    const { receipt } = HostCommitCheckOutputSchema.parse(captured.output);
    expect(receipt).toBeDefined();
    const pushed = { bindingId: 'hb_app', sha: world.sha, base: world.base, receipt };
    expect(() => requireCheckedPush({ ...pushed, argv: REPORTING })).not.toThrow();
  });

  it('says so where they failed, and a push takes it for nothing', async () => {
    const world = await fixture({ branchPrefix: 'aflow/', checks: FAILING });
    const { captured } = await check(world);
    const { receipt } = HostCommitCheckOutputSchema.parse(captured.output);
    expect(receipt).toBeDefined();
    expect(() =>
      requireCheckedPush({
        bindingId: 'hb_app',
        sha: world.sha,
        base: world.base,
        argv: FAILING,
        receipt,
      }),
    ).toThrow(expect.objectContaining({ refusal: 'check_failed' }));
  });

  it('carries nothing of what the checks printed, nor the command itself', async () => {
    const world = await fixture({ branchPrefix: 'aflow/', checks: FAILING });
    const { captured } = await check(world);
    const output = HostCommitCheckOutputSchema.parse(captured.output);
    const body = receiptBody(output.receipt ?? '');
    const fields = JSON.parse(body) as unknown[];
    expect(fields).toEqual([
      'hb_app',
      world.sha,
      world.base,
      expect.any(String),
      'failed',
      expect.any(Number),
    ]);
    expect(body).not.toContain('step one ok');
    expect(body).not.toContain('FAIL tsc');
    expect(body).not.toContain(process.execPath);
    expect(body).not.toContain(output.tail);
  });
});

describe("host.commit.check — the folder's sandbox posture", () => {
  function compiled(input: SandboxedRunInput): ReturnType<typeof compileSandboxPolicy> {
    return compileSandboxPolicy(input.binding, {
      scratchDir: input.scratchDir,
      ...(input.posture !== undefined ? { posture: input.posture } : {}),
      ...(input.widening !== undefined ? { widening: input.widening } : {}),
    });
  }

  it('runs an `open` folder’s checks in the sandbox with the network open, writing only the checkout, the scratch and the temp root', async () => {
    const world = await fixture({ branchPrefix: 'aflow/', checks: REPORTING }, { sandbox: 'open' });
    const { result } = await check(world);
    expect(result.status).toBe('SUCCEEDED');
    const input = handed[0];
    if (input === undefined) throw new Error('the check was not handed to the sandbox');
    expect(input.posture).toBe('open');
    expect(input.cwd).not.toBe(world.repo);
    expect(input.widening).toMatchObject({ writableRoot: input.cwd, withholdBindingWrite: true });
    const policy = compiled(input);
    expect(policy.network[OPEN_ONLY_SANDBOX_OPTION]).toBe(true);
    expect(policy.filesystem.allowWrite).toEqual(
      expect.arrayContaining([input.scratchDir, input.cwd, SYSTEM_TEMP_ROOT]),
    );
    expect(policy.filesystem.allowWrite).not.toContain(world.repo);
  });

  it('takes the default, `open`, for a folder that chose none', async () => {
    const world = await fixture(
      { branchPrefix: 'aflow/', checks: REPORTING },
      { sandbox: undefined },
    );
    await check(world);
    expect(handed.map((input) => input.posture)).toEqual(['open']);
  });

  it('refuses a folder’s checks on a machine with no qualified sandbox, under either posture', async () => {
    sandboxMissing = true;
    for (const sandbox of ['open', 'confined'] as const) {
      const world = await fixture({ branchPrefix: 'aflow/', checks: REPORTING }, { sandbox });
      const refused = await check(world);
      expect(refused.result.status).toBe('FAILED');
      expect(JSON.stringify(refused.captured.output)).toContain('no qualified sandbox');
    }
    expect(handed).toHaveLength(0);
  });

  it('keeps a `confined` folder’s loopback, egress and temp root closed', async () => {
    const world = await fixture(
      { branchPrefix: 'aflow/', checks: REPORTING },
      { sandbox: 'confined' },
    );
    await check(world);
    const input = handed[0];
    if (input === undefined) throw new Error('the check was not handed to the sandbox');
    expect(input.posture).toBe('confined');
    const policy = compiled(input);
    expect(policy.network).toEqual({ allowedDomains: [], deniedDomains: [] });
    expect(JSON.stringify(policy)).not.toContain(OPEN_ONLY_SANDBOX_OPTION);
    expect(policy.filesystem.allowWrite).not.toContain(SYSTEM_TEMP_ROOT);
  });
});

describe('host.commit.check — what it refuses', () => {
  it('refuses checks in a folder that may not run commands', async () => {
    const world = await fixture(
      { branchPrefix: 'aflow/', checks: REPORTING },
      { allowsExecution: false },
    );
    const { result } = await check(world);
    expect(result.status).toBe('FAILED');
    expect(handed).toHaveLength(0);
  });

  it('refuses another workspace naming the folder', async () => {
    const world = await fixture({ branchPrefix: 'aflow/', checks: REPORTING });
    const captured: Captured = { payloads: [], deltas: [] };
    const result = await createHostHandler(world.policyPath, noPushApprovals).execute({
      ...(contextFor(
        { bindingId: 'hb_app', sha: world.sha, base: world.base },
        captured,
      ) as object),
      spaceId: 'space-b',
    } as never);
    expect(result.status).toBe('FAILED');
    expect(JSON.stringify(captured.output)).toContain('was not connected for this workspace');
  });

  it('takes no command from its caller', async () => {
    const world = await fixture({ branchPrefix: 'aflow/', checks: REPORTING });
    const { result } = await check(world, { checks: ['rm', '-rf', '/'] });
    expect(result.status).toBe('SUCCEEDED');
    expect(handed[0]?.argv).toEqual(REPORTING);
  });
});

describe('what a check’s output keeps', () => {
  it('keeps the end of a long output, by bytes, and says how much went', () => {
    const kept = createTailBuffer(10);
    kept.push('0123456789');
    kept.push('abcdef');
    expect(kept.text()).toEqual({ text: '6789abcdef', droppedBytes: 6 });
  });

  it('keeps the whole output where it fits both ends', () => {
    const kept = createHeadTailBuffer(8, 16);
    kept.push('ok a\nok b\n');
    kept.push('FAIL c\n');
    expect(kept.text()).toBe('ok a\nok b\nFAIL c\n');
  });

  it('keeps the start and the failure at the end, the cut marked between whole lines', () => {
    const failure = 'FAIL x.test.ts > a test\nAssertionError: expected 1 to be 2\n';
    const printed = [
      'ok   guards\nok   build a\n',
      ...Array.from({ length: 50 }, (_, i) => `ok   build ${String(i)}\n`),
      failure,
    ];
    const kept = createHeadTailBuffer(16, failure.length + 4);
    for (const chunk of printed) kept.push(chunk);

    const text = kept.text();
    expect(text.startsWith('ok   guards\n[')).toBe(true);
    expect(text.endsWith(`]\n${failure}`)).toBe(true);
    const marker = /^\[(\d+) bytes printed here were not kept\]\n/m.exec(text);
    const keptBytes = Buffer.byteLength(text) - Buffer.byteLength(marker?.[0] ?? '');
    expect(keptBytes + Number(marker?.[1])).toBe(Buffer.byteLength(printed.join('')));
  });

  it('never splits a character between the start and the end', () => {
    const kept = createHeadTailBuffer(2, 8);
    kept.push('aéb');
    expect(kept.text()).toBe('aéb');
  });

  it('never starts inside a character', () => {
    expect(utf8Suffix('aé', 1)).toBe('');
    expect(utf8Suffix('aéb', 2)).toBe('b');
    expect(utf8Suffix('aéb', 3)).toBe('éb');
  });

  it('starts the inline tail at a whole line, within its size', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${String(i)}`).join('\n');
    const tail = checkTail(lines);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(HOST_CHECK_TAIL_BYTES);
    expect(tail.startsWith('line ')).toBe(true);
    expect(tail.endsWith('line 1999')).toBe(true);
    expect(HOST_CHECK_OUTPUT_TAIL_BYTES).toBeGreaterThan(HOST_CHECK_TAIL_BYTES);
  });
});

/** Only where this machine can actually confine a process, as `processExec.test.ts` gates. */
const CAN_CONFINE = actualSandbox.sandboxReadiness().ready;

describe.skipIf(!CAN_CONFINE)('host.commit.check — through the real sandbox', () => {
  it.skipIf(confined.skip)(
    confined.title('runs a passing check confined, and a failing one to its failure'),
    async () => {
      realSandbox = true;
      const passing = await fixture(
        { branchPrefix: 'aflow/', checks: REPORTING },
        { sandbox: 'confined' },
      );
      const passed = await check(passing);
      const output = HostCommitCheckOutputSchema.parse(passed.captured.output);
      expect(output.passed, output.summary).toBe(true);
      expect(output.tail).toContain(passing.sha);

      const failing = await fixture(
        { branchPrefix: 'aflow/', checks: FAILING },
        { sandbox: 'confined' },
      );
      const failed = await check(failing);
      expect(HostCommitCheckOutputSchema.parse(failed.captured.output).passed).toBe(false);
      realSandbox = false;
    },
  );

  it.skipIf(confined.skip)(
    confined.title(
      'reaches neither the machine’s loopback nor anything off it, and its own loopback only where the sandbox has one',
    ),
    async () => {
      const machine = createServer((socket) => socket.end('pong'));
      await new Promise<void>((resolve) => machine.listen(0, '127.0.0.1', resolve));
      const { port } = machine.address() as AddressInfo;
      try {
        realSandbox = true;
        const world = await fixture(
          { branchPrefix: 'aflow/', checks: loopbackAndEgress(port) },
          { sandbox: 'confined' },
        );
        const output = HostCommitCheckOutputSchema.parse((await check(world)).captured.output);
        realSandbox = false;
        expect(output.passed, output.summary).toBe(true);
        expect(output.tail).toMatch(/machine E[A-Z]+/);
        expect(output.tail).toMatch(/egress E[A-Z]+/);
        if (process.platform === 'linux') expect(output.tail).toContain('own pong');
        else expect(output.tail).toMatch(/own E[A-Z]+/);
      } finally {
        machine.close();
      }
    },
  );
});
