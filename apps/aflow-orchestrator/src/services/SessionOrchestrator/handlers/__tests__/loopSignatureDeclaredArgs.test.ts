import { describe, expect, it } from 'vitest';
import { MEMORY_READ_OPERATION_ID, RUN_OUTPUT_READ_OPERATION_ID } from '@aflow/schemas';
import {
  buildCallSignature,
  countRepeatedCall,
  hasDeclaredSignature,
  HARD_PAUSE_IDENTICAL_CONSECUTIVE,
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

describe('declared per-operation signature', () => {
  it('ignores every declared read-shape argument', () => {
    const bare = signatureArgs(MEMORY_READ_OPERATION_ID, { target: { path: RUN_DETAIL_PATH } });
    const shaped = signatureArgs(MEMORY_READ_OPERATION_ID, {
      target: { path: RUN_DETAIL_PATH },
      jsonPath: 'tasks[7]',
      view: 'outline',
      byteRange: { start: 0, end: 10 },
      lineRange: { startLine: 0, endLine: 5 },
      itemRange: { start: 3, count: 1 },
      maxBytes: 4096,
    });
    expect(shaped).toEqual(bare);
    expect(shaped).toEqual({ 'target.path': RUN_DETAIL_PATH });
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
