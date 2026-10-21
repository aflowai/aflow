/**
 * Contract: what a host command prints streams on `activity`, as `output`
 * lines under its step, and never on `text`, the channel a reader renders as
 * the step speaking.
 *
 * The command runs under a stand-in for the sandbox, as the handler suites do,
 * so the channel is asserted wherever the suite runs; the confined spawn path
 * is held by `processExec.test.ts` where this machine can confine one.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HarnessActivityLineSchema, type HarnessActivityLine } from '@aflow/schemas';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createHostProcessHandler } from '../handlers/processHandlers.js';
import type { SandboxedRunInput, SandboxedRunResult } from '../sandboxedRun.js';
import { noPushApprovals } from './fixtures/pushApprovals.js';

/** As a pipe delivers it: cut mid-line, and with the adapter's own narration. */
const CHUNKS = [
  'compiling 1/2\ncompil',
  'ing 2/2\n[SandboxDebug] Connection blocked to registry.example.com:443\n',
  'done, no trailing newline',
];

vi.mock('../sandboxedRun.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandboxedRun.js')>();
  return {
    ...actual,
    sandboxReadiness: () => ({ ready: true, missing: [] }),
    runSandboxed: (input: SandboxedRunInput): Promise<SandboxedRunResult> => {
      for (const chunk of CHUNKS) input.onDelta(chunk);
      return Promise.resolve({
        processId: 'hp_test',
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 1,
        stdout: CHUNKS.join(''),
        stderr: '',
        truncated: false,
      });
    },
  };
});

let policyPath: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'host-output-'));
  const root = join(base, 'project');
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
      ],
    }),
  );
});

describe('a host command’s live output', () => {
  it('streams on `activity` as the lines it printed, never on `text`', async () => {
    const frames: Array<{ channel: string; delta: string }> = [];
    const result = await createHostProcessHandler(policyPath, noPushApprovals).execute({
      operationId: 'host.process.exec',
      tenantId: 'tenant-test',
      spaceId: 'space-test',
      runId: 'run-test',
      stepExecutionId: 'step-test',
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () => Promise.resolve({ bindingId: 'hb', command: ['make'] }),
      emitLiveDelta: (channel: string, delta: string) => {
        frames.push({ channel, delta });
        return Promise.resolve();
      },
      writePayload: () => Promise.resolve('inline:out'),
    } as never);

    expect(result.status).toBe('SUCCEEDED');
    expect(frames.length).toBeGreaterThan(0);
    expect(new Set(frames.map((frame) => frame.channel))).toEqual(new Set(['activity']));
    const lines: HarnessActivityLine[] = frames
      .flatMap((frame) => frame.delta.split('\n'))
      .filter((segment) => segment !== '')
      .map((segment) => HarnessActivityLineSchema.parse(JSON.parse(segment)));
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ['output', 'compiling 1/2'],
      ['output', 'compiling 2/2'],
      ['output', 'done, no trailing newline'],
    ]);
  });
});
