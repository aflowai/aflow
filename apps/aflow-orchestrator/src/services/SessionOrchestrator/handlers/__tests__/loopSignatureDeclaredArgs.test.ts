import { describe, expect, it } from 'vitest';
import { MEMORY_READ_OPERATION_ID, RUN_OUTPUT_READ_OPERATION_ID } from '@aflow/schemas';
import {
  buildCallSignature,
  countRepeatedCall,
  countSameTargetReads,
  HARD_PAUSE_IDENTICAL_CONSECUTIVE,
  HARD_PAUSE_SAME_TARGET_READS,
  readsStoredTarget,
  readTargetKey,
  readTargetKeys,
  repeatedReadWarning,
  SAME_TARGET_WINDOW,
  sameTargetReadWarning,
  SIGNATURE_WINDOW,
  SOFT_WARNING_IDENTICAL_CONSECUTIVE,
  SOFT_WARNING_SAME_TARGET_READS,
  signatureArgs,
  type RepeatVerdict,
  type ResolveCallOperation,
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

interface TurnCount {
  /** The identical-call rule. */
  verdict: RepeatVerdict;
  consecutiveCount: number;
  recentSignatures: string[];
  /** The same-target rule. */
  sameTargetVerdict: RepeatVerdict;
  readCount: number;
  recentReadTargets: string[][];
}

/** Drives both rules one turn at a time, as applyAgentDecision does. */
function runTurns(
  turns: ReadonlyArray<ReadonlyArray<SignatureCall>>,
  resolve?: ResolveCallOperation,
): TurnCount[] {
  let signatures: string[] = [];
  let readTargets: string[][] = [];
  return turns.map((calls) => {
    const identical = countRepeatedCall(signatures, buildCallSignature(calls));
    const sameTarget = countSameTargetReads(readTargets, readTargetKeys(calls, resolve));
    signatures = identical.recentSignatures;
    readTargets = sameTarget.recentReadTargets;
    return {
      verdict: identical.verdict,
      consecutiveCount: identical.consecutiveCount,
      recentSignatures: identical.recentSignatures,
      sameTargetVerdict: sameTarget.verdict,
      readCount: sameTarget.readCount,
      recentReadTargets: sameTarget.recentReadTargets,
    };
  });
}

function repeat<T>(length: number, at: (i: number) => T): T[] {
  return Array.from({ length }, (_, i) => at(i));
}

describe('identical-call rule on reads of one stored target', () => {
  it('warns at 3 and pauses at 5 identical reads, and the same-target rule stays silent', () => {
    const loop = runTurns(repeat(HARD_PAUSE_IDENTICAL_CONSECUTIVE, () => [readTask(0)]));

    expect(loop.map((c) => c.consecutiveCount)).toEqual([1, 2, 3, 4, 5]);
    expect(loop.map((c) => c.verdict)).toEqual([
      'none',
      'none',
      'warning',
      'final_warning',
      'pause',
    ]);
    expect(loop.every((c) => c.sameTargetVerdict === 'none')).toBe(true);
    expect(loop.at(-1)?.readCount).toBeLessThan(SOFT_WARNING_SAME_TARGET_READS);
  });

  it('pauses identical reads through the run-output read', () => {
    const read: SignatureCall = {
      toolId: RUN_OUTPUT_READ_OPERATION_ID,
      args: { path: RUN_DETAIL_PATH, jsonPath: 'tasks[0]', view: 'content' },
    };
    const loop = runTurns(repeat(HARD_PAUSE_IDENTICAL_CONSECUTIVE, () => [read]));
    expect(loop.at(-1)?.verdict).toBe('pause');
    expect(loop.every((c) => c.sameTargetVerdict === 'none')).toBe(true);
  });

  it('does not count section navigation by distinct jsonPaths as an identical call', () => {
    const loop = runTurns(repeat(HARD_PAUSE_IDENTICAL_CONSECUTIVE, (i) => [readTask(i)]));
    expect(loop.map((c) => c.consecutiveCount)).toEqual([1, 1, 1, 1, 1]);
    expect(loop.every((c) => c.verdict === 'none')).toBe(true);
  });

  it('separates reads of one target that differ only in view', () => {
    const read = (view: string): SignatureCall => ({
      toolId: MEMORY_READ_OPERATION_ID,
      args: { target: { path: RUN_DETAIL_PATH }, view },
    });
    expect(buildCallSignature([read('stat')])).not.toBe(buildCallSignature([read('outline')]));
  });

  it('keeps the window bounded', () => {
    const loop = runTurns(repeat(90, () => [readTask(0)]));
    expect(loop.at(-1)?.recentSignatures).toHaveLength(SIGNATURE_WINDOW);
    expect(loop.at(-1)?.verdict).toBe('pause');
  });
});

describe('same-target rule on reads of one stored target', () => {
  it('warns at 8 and pauses at 12 reads by distinct jsonPaths, and the identical-call rule stays silent', () => {
    const loop = runTurns(repeat(HARD_PAUSE_SAME_TARGET_READS, (i) => [readTask(i)]));

    expect(loop.map((c) => c.readCount)).toEqual(
      repeat(HARD_PAUSE_SAME_TARGET_READS, (i) => i + 1),
    );
    expect(
      loop
        .slice(0, SOFT_WARNING_SAME_TARGET_READS - 1)
        .every((c) => c.sameTargetVerdict === 'none'),
    ).toBe(true);
    expect(loop[SOFT_WARNING_SAME_TARGET_READS - 1]?.sameTargetVerdict).toBe('warning');
    expect(loop[HARD_PAUSE_SAME_TARGET_READS - 2]?.sameTargetVerdict).toBe('final_warning');
    expect(loop[HARD_PAUSE_SAME_TARGET_READS - 1]?.sameTargetVerdict).toBe('pause');

    expect(loop.every((c) => c.consecutiveCount === 1)).toBe(true);
    expect(loop.every((c) => c.verdict === 'none')).toBe(true);
  });

  it('pauses the same loop through the run-output read', () => {
    const loop = runTurns(
      repeat(HARD_PAUSE_SAME_TARGET_READS, (i) => [
        {
          toolId: RUN_OUTPUT_READ_OPERATION_ID,
          args: { path: RUN_DETAIL_PATH, jsonPath: `tasks[${String(i)}]`, view: 'content' },
        },
      ]),
    );
    expect(loop.at(-1)?.sameTargetVerdict).toBe('pause');
    expect(loop.every((c) => c.verdict === 'none')).toBe(true);
  });

  it('counts reads that differ in view, version or window as reads of one target', () => {
    const shapes: Record<string, unknown>[] = [
      { view: 'outline' },
      { view: 'links' },
      { jsonPath: 'tasks' },
      { byteRange: { start: 0, end: 10 } },
      { lineRange: { startLine: 0, endLine: 5 } },
      { itemRange: { start: 3, count: 1 } },
      { maxBytes: 4096 },
    ];
    const keys = shapes.map((shape) =>
      readTargetKey(MEMORY_READ_OPERATION_ID, { target: { path: RUN_DETAIL_PATH }, ...shape }),
    );
    keys.push(
      readTargetKey(MEMORY_READ_OPERATION_ID, { target: { path: RUN_DETAIL_PATH, version: 2 } }),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('counts a flat and a nested spelling of one target together', () => {
    const id = '7b8f3a52-1f0e-4c1e-9d4a-2a6c1b0e5f11';
    expect(readTargetKey(MEMORY_READ_OPERATION_ID, { path: RUN_DETAIL_PATH })).toBe(
      readTargetKey(MEMORY_READ_OPERATION_ID, { target: { path: RUN_DETAIL_PATH } }),
    );
    expect(readTargetKey(MEMORY_READ_OPERATION_ID, { id, view: 'stat' })).toBe(
      readTargetKey(MEMORY_READ_OPERATION_ID, { target: { id } }),
    );
  });

  it('keeps reads of different targets apart', () => {
    const loop = runTurns(
      repeat(HARD_PAUSE_SAME_TARGET_READS, (i) => [
        readTask(i, `/run/outputs/call${String(i % 2)}_0/data`),
      ]),
    );
    expect(loop.at(-1)?.readCount).toBe(HARD_PAUSE_SAME_TARGET_READS / 2);
    expect(loop.every((c) => c.sameTargetVerdict === 'none')).toBe(true);
  });

  it('counts each read of a turn that reads one target in parallel', () => {
    const loop = runTurns([repeat(HARD_PAUSE_SAME_TARGET_READS, (i) => readTask(i))]);
    expect(loop[0]?.readCount).toBe(HARD_PAUSE_SAME_TARGET_READS);
    expect(loop[0]?.sameTargetVerdict).toBe('pause');
  });

  it('counts over a window of turns, so reads spread out age out of it', () => {
    const other: SignatureCall = { toolId: 'memory.store.query', args: { prefix: '/notes' } };
    const spread = runTurns(
      repeat(SAME_TARGET_WINDOW * 3, (i) => [i % 2 === 0 ? readTask(i) : other]),
    );
    expect(spread.at(-1)?.recentReadTargets).toHaveLength(SAME_TARGET_WINDOW);
    expect(Math.max(...spread.map((c) => c.readCount))).toBe(SAME_TARGET_WINDOW / 2);
    expect(spread.some((c) => c.sameTargetVerdict === 'pause')).toBe(false);
  });

  it('resolves a graph step to the operation it runs', () => {
    const resolve = (toolId: string) =>
      toolId === 'read_detail' ? MEMORY_READ_OPERATION_ID : toolId;
    const loop = runTurns(
      repeat(HARD_PAUSE_SAME_TARGET_READS, (i) => [
        {
          toolId: 'read_detail',
          args: { target: { path: RUN_DETAIL_PATH }, jsonPath: `tasks[${String(i)}]` },
        },
      ]),
      resolve,
    );
    expect(loop.at(-1)?.sameTargetVerdict).toBe('pause');
    expect(readsStoredTarget([{ toolId: 'read_detail' }], resolve)).toBe(true);
  });

  it('reads no target for an operation with no declaration', () => {
    expect(readsStoredTarget([{ toolId: 'memory.store.query' }])).toBe(false);
    expect(readTargetKey('memory.store.query', { path: RUN_DETAIL_PATH })).toBeUndefined();
    expect(readTargetKey('draft_patch', { path: RUN_DETAIL_PATH })).toBeUndefined();
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
      expect(
        counts
          .slice(0, SOFT_WARNING_SAME_TARGET_READS - 1)
          .every((c) => c.sameTargetVerdict === 'none'),
      ).toBe(true);
    });
  }

  it('counts a long paging of one target toward the same-target rule', () => {
    const counts = runTurns(
      repeat(SOFT_WARNING_SAME_TARGET_READS, (i) => [
        {
          toolId: MEMORY_READ_OPERATION_ID,
          args: {
            target: { path: RUN_DETAIL_PATH },
            byteRange: { start: i * WINDOW, end: (i + 1) * WINDOW },
          },
        },
      ]),
    );
    expect(counts.at(-1)?.readCount).toBe(SOFT_WARNING_SAME_TARGET_READS);
    expect(counts.at(-1)?.sameTargetVerdict).toBe('warning');
    expect(counts.every((c) => c.verdict === 'none')).toBe(true);
  });

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

  it('pauses a jsonPath loop inside one window through the same-target rule', () => {
    const loop = runTurns(
      repeat(HARD_PAUSE_SAME_TARGET_READS, (i) => [
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
    expect(loop.every((c) => c.verdict === 'none')).toBe(true);
    expect(loop.at(-1)?.sameTargetVerdict).toBe('pause');
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

  it('names the remedy for a same-target loop', () => {
    const text = sameTargetReadWarning(SOFT_WARNING_SAME_TARGET_READS);
    expect(text).toContain(`8 times in the last ${String(SAME_TARGET_WINDOW)} turns`);
    expect(text).toContain('Read the target whole or by window, not section by section.');
    expect(text).toContain('15,000 characters');
    expect(text).toContain('byteRange, lineRange or itemRange');
  });
});

describe('identical-call signature', () => {
  it('keeps jsonPath, view, version and every window argument', () => {
    const windowed = {
      byteRange: { start: 0, end: 10 },
      lineRange: { startLine: 0, endLine: 5 },
      itemRange: { start: 3, count: 1 },
      maxBytes: 4096,
    };
    const args = {
      target: { path: RUN_DETAIL_PATH, version: 2 },
      jsonPath: 'tasks',
      view: 'content',
      ...windowed,
    };
    expect(signatureArgs(args)).toEqual(args);
    expect(
      signatureArgs({ path: RUN_DETAIL_PATH, jsonPath: 'tasks', view: 'content', ...windowed }),
    ).toEqual({ path: RUN_DETAIL_PATH, jsonPath: 'tasks', view: 'content', ...windowed });
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

  it('keeps all arguments minus replay keys', () => {
    const query = 'memory.store.query';
    expect(
      signatureArgs({ mutationId: 'm-1', prefix: '/notes', jsonPath: 'x', view: 'stat' }),
    ).toEqual({ prefix: '/notes', jsonPath: 'x', view: 'stat' });
    expect(buildCallSignature([{ toolId: query, args: { prefix: '/a', limit: 1 } }])).not.toBe(
      buildCallSignature([{ toolId: query, args: { prefix: '/a', limit: 2 } }]),
    );
    expect(signatureArgs({ mutationId: 'm', operations: [] })).toEqual({ operations: [] });
  });
});
