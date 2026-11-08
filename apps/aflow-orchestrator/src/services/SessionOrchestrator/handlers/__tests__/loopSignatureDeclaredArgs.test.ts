import { describe, expect, it } from 'vitest';
import { MEMORY_READ_OPERATION_ID, RUN_OUTPUT_READ_OPERATION_ID } from '@aflow/schemas';
import {
  buildCallSignature,
  countRepeatedCall,
  hasDeclaredSignature,
  HARD_PAUSE_IDENTICAL_CONSECUTIVE,
  repeatedReadWarning,
  SIGNATURE_WINDOW,
  SOFT_WARNING_IDENTICAL_CONSECUTIVE,
  signatureArgs,
  type RepeatCount,
  type SignatureCall,
} from '../callSignature.js';

/**
 * A Helmsman read tasks[i] of one stored run detail one index at a time, about
 * 90 reads. Each read was cleared from context within a few turns, so it read
 * indices it had already read. Every jsonPath differed and every read
 * succeeded, so neither the repeat detector nor the failure counters moved.
 */
const RUN_DETAIL_PATH = '/run/outputs/abc123_0/data';

function readTask(index: number, path = RUN_DETAIL_PATH): SignatureCall {
  return {
    toolId: MEMORY_READ_OPERATION_ID,
    args: { target: { path }, view: 'content', jsonPath: `tasks[${String(index)}].status` },
  };
}

/** Drives the detector one turn at a time, as applyAgentDecision does. */
function runTurns(turns: ReadonlyArray<ReadonlyArray<SignatureCall>>): RepeatCount[] {
  let window: string[] = [];
  return turns.map((calls) => {
    const count = countRepeatedCall(window, buildCallSignature(calls));
    window = count.recentSignatures;
    return count;
  });
}

describe('repeat detector on reads of one stored target', () => {
  it('warns and then pauses the index-at-a-time loop, as it does identical calls', () => {
    const loop = runTurns(
      Array.from({ length: HARD_PAUSE_IDENTICAL_CONSECUTIVE }, (_, i) => [readTask(i)]),
    );
    const identical = runTurns(
      Array.from({ length: HARD_PAUSE_IDENTICAL_CONSECUTIVE }, () => [readTask(0)]),
    );

    expect(loop.map((c) => c.verdict)).toEqual(identical.map((c) => c.verdict));
    expect(loop.map((c) => c.consecutiveCount)).toEqual([1, 2, 3, 4, 5]);
    expect(loop[SOFT_WARNING_IDENTICAL_CONSECUTIVE - 1]?.verdict).toBe('warning');
    expect(loop[HARD_PAUSE_IDENTICAL_CONSECUTIVE - 2]?.verdict).toBe('final_warning');
    expect(loop[HARD_PAUSE_IDENTICAL_CONSECUTIVE - 1]?.verdict).toBe('pause');
    expect(loop.slice(0, SOFT_WARNING_IDENTICAL_CONSECUTIVE - 1).map((c) => c.verdict)).toEqual([
      'none',
      'none',
    ]);
  });

  it('pauses the same loop through the run-output read', () => {
    const loop = runTurns(
      Array.from({ length: HARD_PAUSE_IDENTICAL_CONSECUTIVE }, (_, i) => [
        {
          toolId: RUN_OUTPUT_READ_OPERATION_ID,
          args: { path: RUN_DETAIL_PATH, jsonPath: `tasks[${String(i)}]`, view: 'content' },
        },
      ]),
    );
    expect(loop.at(-1)?.verdict).toBe('pause');
  });

  it('keeps the window bounded', () => {
    const loop = runTurns(Array.from({ length: 90 }, (_, i) => [readTask(i)]));
    expect(loop.at(-1)?.recentSignatures).toHaveLength(SIGNATURE_WINDOW);
    expect(loop.at(-1)?.verdict).toBe('pause');
  });

  it('resolves a graph step to the operation it runs', () => {
    const resolve = (toolId: string) =>
      toolId === 'read_detail' ? MEMORY_READ_OPERATION_ID : toolId;
    const a = buildCallSignature(
      [{ toolId: 'read_detail', args: { target: { path: RUN_DETAIL_PATH }, jsonPath: 'a' } }],
      resolve,
    );
    const b = buildCallSignature(
      [{ toolId: 'read_detail', args: { target: { path: RUN_DETAIL_PATH }, jsonPath: 'b' } }],
      resolve,
    );
    expect(a).toBe(b);
    expect(hasDeclaredSignature([{ toolId: 'read_detail' }], resolve)).toBe(true);
  });
});

describe('windowed reads of one stored target', () => {
  const WINDOW = 15_000;

  const storeWindows: Record<string, (i: number) => Record<string, unknown>> = {
    byteRange: (i) => ({ byteRange: { start: i * WINDOW, end: (i + 1) * WINDOW } }),
    lineRange: (i) => ({ lineRange: { startLine: i * 200, endLine: (i + 1) * 200 } }),
    itemRange: (i) => ({ jsonPath: 'tasks', itemRange: { start: i * 50, count: 50 } }),
    maxBytes: (i) => ({ maxBytes: (i + 1) * 20_000 }),
  };

  for (const [windowArg, windowAt] of Object.entries(storeWindows)) {
    it(`runs a paging of one document by ${windowArg} to completion`, () => {
      const turns = Array.from({ length: SIGNATURE_WINDOW + 4 }, (_, i) => [
        {
          toolId: MEMORY_READ_OPERATION_ID,
          args: { target: { path: RUN_DETAIL_PATH }, view: 'content', ...windowAt(i) },
        },
      ]);
      const counts = runTurns(turns);
      expect(counts.map((c) => c.verdict).every((v) => v === 'none')).toBe(true);
      expect(counts.map((c) => c.consecutiveCount).every((n) => n === 1)).toBe(true);
    });
  }

  it('runs a paging of one truncated run output to completion', () => {
    const turns = Array.from({ length: SIGNATURE_WINDOW + 4 }, (_, i) => [
      {
        toolId: RUN_OUTPUT_READ_OPERATION_ID,
        args: {
          path: RUN_DETAIL_PATH,
          view: 'content',
          lineRange: { startLine: i * 200, endLine: (i + 1) * 200 },
        },
      },
    ]);
    expect(runTurns(turns).every((c) => c.verdict === 'none')).toBe(true);
  });

  it('still pauses a repeat of one window', () => {
    const read: SignatureCall = {
      toolId: MEMORY_READ_OPERATION_ID,
      args: { target: { path: RUN_DETAIL_PATH }, byteRange: { start: 0, end: WINDOW } },
    };
    const loop = runTurns(Array.from({ length: HARD_PAUSE_IDENTICAL_CONSECUTIVE }, () => [read]));
    expect(loop.at(-1)?.verdict).toBe('pause');
  });

  it('pauses a jsonPath loop inside one window', () => {
    const loop = runTurns(
      Array.from({ length: HARD_PAUSE_IDENTICAL_CONSECUTIVE }, (_, i) => [
        {
          toolId: MEMORY_READ_OPERATION_ID,
          args: {
            target: { path: RUN_DETAIL_PATH },
            maxBytes: 4096,
            jsonPath: `tasks[${String(i)}]`,
          },
        },
      ]),
    );
    expect(loop.at(-1)?.verdict).toBe('pause');
  });

  it('treats successive versions of one document as distinct reads', () => {
    const versions = (nested: boolean) =>
      runTurns(
        Array.from({ length: HARD_PAUSE_IDENTICAL_CONSECUTIVE }, (_, i) => [
          {
            toolId: MEMORY_READ_OPERATION_ID,
            args: nested
              ? { target: { path: '/notes/plan.md', version: i + 1 }, view: 'content' }
              : { path: '/notes/plan.md', version: i + 1, view: 'content' },
          },
        ]),
      );
    expect(versions(true).every((c) => c.verdict === 'none')).toBe(true);
    expect(versions(false).every((c) => c.verdict === 'none')).toBe(true);
  });
});

describe('repeated-read warning', () => {
  it('names the default window and the arguments that read past it', () => {
    const text = repeatedReadWarning(SOFT_WARNING_IDENTICAL_CONSECUTIVE);
    expect(text).toContain('3 times in a row');
    expect(text).toContain('15,000 characters');
    expect(text).toContain('explicit maxBytes');
    expect(text).toContain('byteRange, lineRange or itemRange');
  });
});

describe('declared per-operation signature', () => {
  it('ignores jsonPath and view, and keeps every window argument', () => {
    const bare = signatureArgs(MEMORY_READ_OPERATION_ID, { target: { path: RUN_DETAIL_PATH } });
    expect(
      signatureArgs(MEMORY_READ_OPERATION_ID, {
        target: { path: RUN_DETAIL_PATH },
        jsonPath: 'tasks[7]',
        view: 'outline',
      }),
    ).toEqual(bare);
    expect(bare).toEqual({ 'target.path': RUN_DETAIL_PATH });

    const windowed = {
      byteRange: { start: 0, end: 10 },
      lineRange: { startLine: 0, endLine: 5 },
      itemRange: { start: 3, count: 1 },
      maxBytes: 4096,
    };
    expect(
      signatureArgs(MEMORY_READ_OPERATION_ID, {
        target: { path: RUN_DETAIL_PATH, version: 2 },
        jsonPath: 'tasks',
        ...windowed,
      }),
    ).toEqual({ 'target.path': RUN_DETAIL_PATH, 'target.version': 2, ...windowed });
    expect(
      signatureArgs(RUN_OUTPUT_READ_OPERATION_ID, {
        path: RUN_DETAIL_PATH,
        jsonPath: 'tasks',
        view: 'content',
        ...windowed,
      }),
    ).toEqual({ path: RUN_DETAIL_PATH, ...windowed });
  });

  it('keeps target.id where the call sends one', () => {
    const id = '7b8f3a52-1f0e-4c1e-9d4a-2a6c1b0e5f11';
    expect(signatureArgs(MEMORY_READ_OPERATION_ID, { target: { id }, view: 'stat' })).toEqual({
      'target.id': id,
    });
  });

  it('still separates reads of different targets', () => {
    expect(buildCallSignature([readTask(0, '/run/outputs/abc123_0/data')])).not.toBe(
      buildCallSignature([readTask(0, '/run/outputs/def456_0/data')]),
    );
    const loop = runTurns(
      Array.from({ length: HARD_PAUSE_IDENTICAL_CONSECUTIVE }, (_, i) => [
        readTask(0, `/run/outputs/call${String(i)}_0/data`),
      ]),
    );
    expect(loop.map((c) => c.verdict)).toEqual(['none', 'none', 'none', 'none', 'none']);
  });

  it('keeps all arguments minus replay keys for an operation with no declaration', () => {
    const query = 'memory.store.query';
    expect(hasDeclaredSignature([{ toolId: query }])).toBe(false);
    expect(
      signatureArgs(query, { mutationId: 'm-1', prefix: '/notes', jsonPath: 'x', view: 'stat' }),
    ).toEqual({ prefix: '/notes', jsonPath: 'x', view: 'stat' });
    expect(buildCallSignature([{ toolId: query, args: { prefix: '/a', limit: 1 } }])).not.toBe(
      buildCallSignature([{ toolId: query, args: { prefix: '/a', limit: 2 } }]),
    );
  });

  it('keeps all arguments minus replay keys for a tool that is no operation', () => {
    expect(signatureArgs('draft_patch', { mutationId: 'm', operations: [] })).toEqual({
      operations: [],
    });
  });
});
