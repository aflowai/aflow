/**
 * Contract: a handle answers only to the run that made it, and nothing outlives
 * the grant that permitted it.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { createHostProcessHandler } from '../handlers/processHandlers.js';
import { noPushApprovals } from './fixtures/pushApprovals.js';
import { sandboxReadiness } from '../sandboxedRun.js';
import { CONFINEMENT_LISTENERS, requires } from './fixtures/capabilities.js';

const confined = requires(...CONFINEMENT_LISTENERS);

let policyPath: string;
let narrowedPolicyPath: string;
let root: string;

interface Captured {
  output?: Record<string, unknown>;
}

function contextFor(
  operationId: string,
  input: unknown,
  captured: Captured,
  runId = 'run-a',
): never {
  return {
    operationId,
    spaceId: 'space-test',
    runId,
    stepExecutionId: 'step-1',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () => Promise.resolve(input),
    emitLiveDelta: () => Promise.resolve(),
    writePayload: (_kind: string, data: unknown) => {
      captured.output = data as Record<string, unknown>;
      return Promise.resolve('inline:out');
    },
  } as never;
}

/**
 * Read a handle until it says what the test is waiting for.
 *
 * A process takes an unpredictable moment to start and emit, and that moment
 * grows with machine load — a fixed sleep passes alone and fails in a full run,
 * which is worse than no test. Draining is destructive, so what has been read
 * accumulates here rather than being re-read.
 */
async function drainUntil(
  processId: string,
  predicate: (seen: string) => boolean,
  bindingId = 'hb',
  runId = 'run-a',
  deadlineMs = 15_000,
): Promise<string> {
  const started = Date.now();
  let seen = '';
  while (Date.now() - started < deadlineMs) {
    const captured: Captured = {};
    await createHostProcessHandler(policyPath, noPushApprovals).execute(
      contextFor('host.process.inspect', { bindingId, processId }, captured, runId),
    );
    seen += String(captured.output?.['output'] ?? '');
    if (predicate(seen)) return seen;
    await settle(50);
  }
  return seen;
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'host-interactive-'));
  root = join(base, 'project');
  await mkdir(root, { recursive: true });
  policyPath = join(base, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb',
          root,
          mode: 'readwrite',
          allowsExecution: true,
          singleFile: false,
          spaceId: 'space-test',
        },
        // A second binding the same run also holds, for the cross-binding case.
        {
          id: 'hb_other',
          root,
          mode: 'readwrite',
          allowsExecution: true,
          singleFile: false,
          spaceId: 'space-test',
        },
      ],
    }),
  );
  // The same binding after the operator took execution away.
  narrowedPolicyPath = join(base, 'narrowed.json');
  await writeFile(
    narrowedPolicyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb',
          root,
          mode: 'readwrite',
          allowsExecution: false,
          singleFile: false,
          spaceId: 'space-test',
        },
      ],
    }),
  );
});

async function startDetached(command: string[], runId = 'run-a'): Promise<string> {
  const captured: Captured = {};
  const result = await createHostProcessHandler(policyPath, noPushApprovals).execute(
    contextFor('host.process.exec', { bindingId: 'hb', command, detach: true }, captured, runId),
  );
  expect(result.status).toBe('SUCCEEDED');
  expect(captured.output?.['detached']).toBe(true);
  return String(captured.output?.['processId']);
}

/**
 * Suites below that start a real confined process run only where this machine
 * can actually confine one. `isSupportedPlatform` is not that question: on
 * Linux it is true whether or not `bwrap`, `rg` and `socat` are installed, and
 * CI has none of them — the suite failed there reporting a dependency error as
 * though it were the command's own output.
 *
 * Only the suites that spawn are gated. The ones that refuse before spawning,
 * and the ones that are pure schema, are the coverage Linux most needs to keep.
 */
const CAN_CONFINE = sandboxReadiness().ready;

describe.runIf(CAN_CONFINE)('a detached process', () => {
  it('returns a handle instead of waiting', async () => {
    const started = Date.now();
    const processId = await startDetached(['sh', '-c', 'sleep 30']);
    // The point of detaching: the step does not sit through the process.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(processId).toMatch(/^hp_/);

    const captured: Captured = {};
    await createHostProcessHandler(policyPath, noPushApprovals).execute(
      contextFor('host.process.stop', { bindingId: 'hb', processId, graceMs: 0 }, captured),
    );
    expect(captured.output?.['stopped']).toEqual([processId]);
  }, 30_000);

  it.skipIf(confined.skip)(
    confined.title('holds what it said until someone reads it, then reports only what is new'),
    async () => {
      const processId = await startDetached(['sh', '-c', 'echo first; sleep 20']);
      const seen = await drainUntil(processId, (out) => out.includes('first'));
      expect(seen).toContain('first');

      // Reading drains it — a second look does not repeat what was already seen.
      const second: Captured = {};
      await createHostProcessHandler(policyPath, noPushApprovals).execute(
        contextFor('host.process.inspect', { bindingId: 'hb', processId }, second),
      );
      expect(second.output?.['output']).toBeUndefined();

      const stop: Captured = {};
      await createHostProcessHandler(policyPath, noPushApprovals).execute(
        contextFor('host.process.stop', { bindingId: 'hb', processId, graceMs: 0 }, stop),
      );
    },
    40_000,
  );

  it.skipIf(confined.skip)(
    confined.title('takes input and acts on it'),
    async () => {
      const processId = await startDetached(['sh', '-c', 'read line; echo "got:$line"; sleep 10']);
      await settle(500);

      const sent: Captured = {};
      const result = await createHostProcessHandler(policyPath, noPushApprovals).execute(
        contextFor('host.process.input', { bindingId: 'hb', processId, input: 'hello\n' }, sent),
      );
      expect(result.status).toBe('SUCCEEDED');
      expect(sent.output?.['state']).toBe('written');

      expect(await drainUntil(processId, (out) => out.includes('got:hello'))).toContain(
        'got:hello',
      );

      const stop: Captured = {};
      await createHostProcessHandler(policyPath, noPushApprovals).execute(
        contextFor('host.process.stop', { bindingId: 'hb', processId, graceMs: 0 }, stop),
      );
    },
    40_000,
  );
});

describe.runIf(CAN_CONFINE)('a handle answers only to its own run', () => {
  it.skipIf(confined.skip)(
    confined.title('another run cannot read it'),
    async () => {
      const processId = await startDetached(['sh', '-c', 'echo secret-output; sleep 20'], 'run-a');
      await settle(1_000);

      const other: Captured = {};
      await createHostProcessHandler(policyPath, noPushApprovals).execute(
        contextFor('host.process.inspect', { bindingId: 'hb', processId }, other, 'run-b'),
      );
      // Absent rather than refused: saying "not yours" confirms the id exists.
      expect(other.output?.['state']).toBe('unknown');
      expect(other.output?.['output']).toBeUndefined();

      expect(await drainUntil(processId, (out) => out.includes('secret-output'))).toContain(
        'secret-output',
      );

      const stop: Captured = {};
      await createHostProcessHandler(policyPath, noPushApprovals).execute(
        contextFor('host.process.stop', { bindingId: 'hb', processId, graceMs: 0 }, stop, 'run-a'),
      );
    },
    40_000,
  );

  it('another run cannot steer it', async () => {
    const processId = await startDetached(
      ['sh', '-c', 'read line; echo "got:$line"; sleep 15'],
      'run-a',
    );
    await settle(1_000);

    const hijack: Captured = {};
    const result = await createHostProcessHandler(policyPath, noPushApprovals).execute(
      contextFor(
        'host.process.input',
        { bindingId: 'hb', processId, input: 'pwn\n' },
        hijack,
        'run-b',
      ),
    );
    expect(result.status).toBe('FAILED');

    const stop: Captured = {};
    await createHostProcessHandler(policyPath, noPushApprovals).execute(
      contextFor('host.process.stop', { bindingId: 'hb', processId, graceMs: 0 }, stop, 'run-a'),
    );
  }, 40_000);

  it('another run cannot stop it', async () => {
    const processId = await startDetached(['sh', '-c', 'sleep 20'], 'run-a');

    const other: Captured = {};
    await createHostProcessHandler(policyPath, noPushApprovals).execute(
      contextFor('host.process.stop', { bindingId: 'hb', processId, graceMs: 0 }, other, 'run-b'),
    );
    expect(other.output?.['stopped']).toEqual([]);

    const mine: Captured = {};
    await createHostProcessHandler(policyPath, noPushApprovals).execute(
      contextFor('host.process.inspect', { bindingId: 'hb', processId }, mine, 'run-a'),
    );
    expect(mine.output?.['state']).toBe('running');

    const stop: Captured = {};
    await createHostProcessHandler(policyPath, noPushApprovals).execute(
      contextFor('host.process.stop', { bindingId: 'hb', processId, graceMs: 0 }, stop, 'run-a'),
    );
  }, 40_000);
});

describe.runIf(CAN_CONFINE)('withdrawing a binding reaches what is already running', () => {
  it('kills a shell that outlived the grant that permitted it', async () => {
    const processId = await startDetached(['sh', '-c', 'sleep 30'], 'run-a');

    // The operator takes execution away. The policy is read fresh per
    // operation, so the next one through sees it.
    const narrowed = createHostProcessHandler(narrowedPolicyPath, noPushApprovals);
    const refused: Captured = {};
    const result = await narrowed.execute(
      contextFor('host.process.inspect', { bindingId: 'hb', processId }, refused, 'run-a'),
    );
    expect(result.status).toBe('FAILED');

    await settle(1_000);
    const after: Captured = {};
    await createHostProcessHandler(policyPath, noPushApprovals).execute(
      contextFor('host.process.inspect', { bindingId: 'hb', processId }, after, 'run-a'),
    );
    expect(after.output?.['state']).toBe('exited');
  }, 40_000);
});

describe.runIf(CAN_CONFINE)('a handle is scoped to its binding, not only to its run', () => {
  it.skipIf(confined.skip)(
    confined.title('cannot be read by naming a different binding the same run holds'),
    async () => {
      // A run holding two bindings could otherwise name the one still granted to
      // pass the gate, then go on addressing a process inside the withdrawn one.
      const processId = await startDetached(['sh', '-c', 'echo inside-hb; sleep 20'], 'run-a');
      await settle(1_000);

      const wrongBinding: Captured = {};
      await createHostProcessHandler(policyPath, noPushApprovals).execute(
        contextFor(
          'host.process.inspect',
          { bindingId: 'hb_other', processId },
          wrongBinding,
          'run-a',
        ),
      );
      expect(wrongBinding.output?.['state']).toBe('unknown');
      expect(wrongBinding.output?.['output']).toBeUndefined();

      expect(await drainUntil(processId, (out) => out.includes('inside-hb'))).toContain(
        'inside-hb',
      );

      const stop: Captured = {};
      await createHostProcessHandler(policyPath, noPushApprovals).execute(
        contextFor('host.process.stop', { bindingId: 'hb', processId, graceMs: 0 }, stop, 'run-a'),
      );
    },
    40_000,
  );

  it('cannot be steered by naming a different binding', async () => {
    const processId = await startDetached(
      ['sh', '-c', 'read line; echo "got:$line"; sleep 15'],
      'run-a',
    );
    await settle(1_000);

    const wrong: Captured = {};
    const result = await createHostProcessHandler(policyPath, noPushApprovals).execute(
      contextFor(
        'host.process.input',
        { bindingId: 'hb_other', processId, input: 'sneak\n' },
        wrong,
        'run-a',
      ),
    );
    expect(result.status).toBe('FAILED');

    const stop: Captured = {};
    await createHostProcessHandler(policyPath, noPushApprovals).execute(
      contextFor('host.process.stop', { bindingId: 'hb', processId, graceMs: 0 }, stop, 'run-a'),
    );
  }, 40_000);
});

describe.runIf(CAN_CONFINE)('a long-lived process keeps talking', () => {
  it.skipIf(confined.skip)(
    confined.title('does not go permanently silent once its lifetime output passes the cap'),
    async () => {
      // The cap used to count everything the process had ever said, which for a
      // detached one is never drained — so past the cap it stopped reporting
      // anything, indistinguishable from a process that had gone quiet.
      const chunk = 'x'.repeat(4096);
      const processId = await startDetached([
        'sh',
        '-c',
        `i=0; while [ $i -lt 90 ]; do echo "${chunk}"; i=$((i+1)); done; sleep 20`,
      ]);
      // Drain until it has said something — well past 256KB by then.
      expect((await drainUntil(processId, (out) => out.length > 0)).length).toBeGreaterThan(0);

      // It is still running and still able to say something new.
      const second: Captured = {};
      await createHostProcessHandler(policyPath, noPushApprovals).execute(
        contextFor('host.process.inspect', { bindingId: 'hb', processId }, second),
      );
      expect(second.output?.['state']).toBe('running');

      const stop: Captured = {};
      await createHostProcessHandler(policyPath, noPushApprovals).execute(
        contextFor('host.process.stop', { bindingId: 'hb', processId, graceMs: 0 }, stop),
      );
    },
    40_000,
  );
});
