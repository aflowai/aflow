import { describe, it, expect } from 'vitest';
import type { AiMessageAtomV1, AiToolResultEnvelopeV1 } from '@aflow/schemas';
import {
  toolResultMessage,
  MEMORY_READ_OPERATION_ID,
  RUN_OUTPUT_READ_OPERATION_ID,
} from '@aflow/schemas';
import { buildClearedExchangeNote } from './exchangeClearing.js';
import { RETENTION_POLICY } from './retentionPolicy.js';
import { estimateStringTokens } from './tokenEstimate.js';

const BASE = 'b'.repeat(32);

function assistantAtom(calls: Array<{ name: string; args?: unknown }>): AiMessageAtomV1 {
  return {
    schemaVersion: 1,
    atomId: 'asst-1',
    role: 'assistant',
    sourceId: 'turn:1',
    sourceKind: 'assistant_turn',
    message: {
      role: 'assistant',
      parts: [{ kind: 'json', json: { action: 'invoke_steps' } }],
      toolCalls: calls.map((c, i) => ({
        toolCallId: `${BASE}_${String(i)}`,
        name: c.name,
        argumentsJson: c.args ?? { code: 'train_model()' },
      })),
    },
    createdAtMs: 1000,
    turnNumber: 1,
  };
}

function resultAtom(
  i: number,
  envelope: Partial<AiToolResultEnvelopeV1> & { toolName: string },
): AiMessageAtomV1 {
  const full: AiToolResultEnvelopeV1 = {
    kind: 'tool_result',
    toolCallId: `${BASE}_${String(i)}`,
    status: 'SUCCEEDED',
    ...envelope,
  };
  return {
    schemaVersion: 1,
    atomId: `res-${String(i)}`,
    role: 'tool',
    sourceId: `${BASE}_${String(i)}`,
    sourceKind: 'tool_result',
    message: toolResultMessage(full),
    createdAtMs: 1001 + i,
    turnNumber: 2,
  };
}

function exchangeOf(asst: AiMessageAtomV1 | undefined, results: AiMessageAtomV1[]) {
  const hydratedById = new Map<string, AiMessageAtomV1>();
  if (asst) hydratedById.set(asst.atomId, asst);
  for (const r of results) hydratedById.set(r.atomId, r);
  const ex = {
    atomRefs: [
      ...(asst ? [{ atomId: asst.atomId, sourceKind: asst.sourceKind }] : []),
      ...results.map((r) => ({ atomId: r.atomId, sourceKind: r.sourceKind })),
    ],
    ...(asst ? { assistantAtom: asst } : {}),
  };
  return { ex, hydratedById };
}

function nonIdempotentExchange(summary: string) {
  return exchangeOf(assistantAtom([{ name: 'compute.sandbox.exec' }]), [
    resultAtom(0, {
      toolName: 'compute.sandbox.exec',
      operationId: 'compute.sandbox.exec',
      durationMs: 2300,
      outputPath: `/run/outputs/${BASE}_0`,
      outputFields: ['data', 'stderr'],
      summary,
    }),
  ]);
}

describe('buildClearedExchangeNote (§4.4)', () => {
  it('non-idempotent exchange: pointer + do-not-re-execute marker, bracketed third-person voice', () => {
    const { ex, hydratedById } = nonIdempotentExchange('stdout: model trained, RMSE 0.114');
    const note = buildClearedExchangeNote(ex, hydratedById, {
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });

    expect(note.startsWith('[Context note — earlier tool exchange (1 tool call) cleared')).toBe(
      true,
    );
    expect(note).toContain('Results remain readable');
    expect(note).toContain(
      `read: memory.store.get { path: '/run/outputs/${BASE}_0/data', view: 'outline' }`,
    );
    expect(note).toContain(
      '⚠ not idempotent — do NOT re-run this call; re-read the stored result instead.',
    );
    // intent + outcome survive: tool name, argument digest, status + duration + summary line
    expect(note).toContain('compute.sandbox.exec({"code":"train_model()"})');
    expect(note).toContain('succeeded (2.3s) — stdout: model trained, RMSE 0.114');
    // the pointer supersedes the bare $ref print
    expect(note).not.toContain('$ref');
  });

  it('shape hint: one-level outline when result data is inline JSON in the envelope', () => {
    const { ex, hydratedById } = nonIdempotentExchange(
      JSON.stringify({ stdout: 'ok', artifacts: [1, 2, 3] }),
    );
    const note = buildClearedExchangeNote(ex, hydratedById, {
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(note).toContain('object: {stdout, artifacts[3]}');
  });

  it('shape hint: falls back to typed outputFields when the inline data is gone', () => {
    const { ex, hydratedById } = nonIdempotentExchange('prose summary, not JSON');
    const note = buildClearedExchangeNote(ex, hydratedById, {
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(note).toContain('fields: data, stderr');
  });

  it('floor-granted run-output read: note teaches memory.run_output.get, no degrade (Plan 233)', () => {
    const { ex, hydratedById } = nonIdempotentExchange('stdout: ok');
    const note = buildClearedExchangeNote(ex, hydratedById, {
      availableReadOpId: RUN_OUTPUT_READ_OPERATION_ID,
    });
    expect(note).toContain(
      `read: memory.run_output.get { path: '/run/outputs/${BASE}_0/data', view: 'outline' }`,
    );
    expect(note).not.toContain('memory.store.get');
    expect(note).toContain('Results remain readable');
    expect(note).not.toContain('$ref');
  });

  it('§4.9 honest degrade: no read promise, shortened marker, digest + size only', () => {
    const { ex, hydratedById } = nonIdempotentExchange(JSON.stringify({ stdout: 'ok' }));
    const note = buildClearedExchangeNote(ex, hydratedById, { availableReadOpId: undefined });

    expect(note).not.toContain('memory.store.get');
    expect(note).not.toContain('Results remain readable');
    expect(note).not.toContain('re-read the stored result');
    expect(note).toContain('⚠ not idempotent — do NOT re-run this call.');
    expect(note).toContain('stored result: '); // size/shape stays
    expect(note.startsWith('[Context note — earlier tool exchange (1 tool call) cleared')).toBe(
      true,
    );
  });

  it('idempotent ops carry no marker', () => {
    const { ex, hydratedById } = exchangeOf(assistantAtom([{ name: 'memory.store.query' }]), [
      resultAtom(0, {
        toolName: 'memory.store.query',
        operationId: 'memory.store.query',
        outputPath: `/run/outputs/${BASE}_0`,
        summary: 'found 3 docs',
      }),
    ]);
    const note = buildClearedExchangeNote(ex, hydratedById, {
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(note).not.toContain('not idempotent');
    expect(note).toContain('read: memory.store.get');
  });

  it('is bounded by noteMaxTokens even for many-call exchanges', () => {
    const calls = Array.from({ length: 30 }, (_, i) => ({
      name: 'compute.sandbox.exec',
      args: { code: `step_${String(i)}: ${'x'.repeat(200)}` },
    }));
    const results = calls.map((_, i) =>
      resultAtom(i, {
        toolName: 'compute.sandbox.exec',
        operationId: 'compute.sandbox.exec',
        outputPath: `/run/outputs/${BASE}_${String(i)}`,
        summary: JSON.stringify({ stdout: 'y'.repeat(300), artifacts: [1, 2, 3, 4, 5] }),
      }),
    );
    const { ex, hydratedById } = exchangeOf(assistantAtom(calls), results);
    const note = buildClearedExchangeNote(ex, hydratedById, {
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(estimateStringTokens(note)).toBeLessThanOrEqual(RETENTION_POLICY.noteMaxTokens);
  });

  it('digest-only fallback survives ONLY for result-only exchanges whose producer is gone', () => {
    const { ex, hydratedById } = exchangeOf(undefined, [
      resultAtom(0, {
        toolName: 'memory.store.query',
        operationId: 'memory.store.query',
        outputRef: `output.${BASE}_0/content`,
        summary: 'found 3 docs',
      }),
    ]);
    const note = buildClearedExchangeNote(ex, hydratedById, {
      availableReadOpId: MEMORY_READ_OPERATION_ID,
    });
    expect(note).toContain('[Context note — 1 earlier tool result cleared to save space.]');
    // legacy digest line, including its $ref tail — no pointer, no outline
    expect(note).toContain(`Full: $ref output.${BASE}_0/content`);
    expect(note).not.toContain('read: memory.store.get');
  });
});
