/**
 * buildEvalTaskResultsFromRows ensures the eval engine
 * sees each task's decoded output (not just metrics) so taskCriteria of
 * type `contains` / `threshold` can look up fields the agent actually
 * produced via submit_output.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { configureLogging } from '@aflow/observability';
import { buildEvalTaskResultsFromRows } from '../evalRunner.js';
import type { WorkflowTaskRow } from '../ledger/types.js';
import type { PayloadStore } from '@aflow/payload-store';
import type { PayloadRef } from '@aflow/schemas';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

function task(partial: Partial<WorkflowTaskRow>): WorkflowTaskRow {
  return {
    id: 'id',
    runId: 'run',
    taskId: 't',
    status: 'succeeded',
    attempt: 1,
    sessionId: null,
    workerSessionId: null,
    startedAt: null,
    completedAt: null,
    durationMs: 0,
    costCents: 0,
    metricsJson: null,
    summary: null,
    failureReason: null,
    outputRef: null,
    reflectionJson: null,
    operationId: null,
    errorCode: null,
    errorClassification: null,
    errorRetryable: null,
    failedAt: null,
    priorFailures: null,
    ...partial,
  };
}

function makePayloadStore(refToData: Record<string, unknown>): PayloadStore {
  return {
    retrieve: vi.fn(async (ref: PayloadRef) => {
      if (ref in refToData) return refToData[ref];
      throw new Error(`unknown ref ${ref}`);
    }),
  } as unknown as PayloadStore;
}

describe('buildEvalTaskResultsFromRows', () => {
  it('decodes outputRef into entry.output when payloadStore is provided', async () => {
    const store = makePayloadStore({
      'inline:exec': { validationScore: 0.835, submit: true },
    });
    const rows = [
      task({ taskId: 'execute', outputRef: 'inline:exec', durationMs: 1000, costCents: 50 }),
    ];
    const results = await buildEvalTaskResultsFromRows(rows, store, { runId: 'r1' });
    expect(results).toHaveLength(1);
    expect(results[0]?.output).toEqual({ validationScore: 0.835, submit: true });
    expect(results[0]?.taskId).toBe('execute');
    expect(results[0]?.durationMs).toBe(1000);
    expect(results[0]?.costCents).toBe(50);
  });

  it('omits output when payloadStore is undefined (preserves pre-fix behavior)', async () => {
    const rows = [
      task({
        taskId: 'execute',
        outputRef: 'inline:exec',
        metricsJson: { validationScore: 0.5 },
      }),
    ];
    const results = await buildEvalTaskResultsFromRows(rows, undefined, { runId: 'r1' });
    expect(results[0]?.output).toBeUndefined();
    expect(results[0]?.metrics).toEqual({ validationScore: 0.5 });
  });

  it('omits output (without throwing) when retrieve fails', async () => {
    const store = makePayloadStore({}); // empty — any ref throws
    const rows = [task({ taskId: 'execute', outputRef: 'gs://missing/x', summary: 'ran' })];
    const results = await buildEvalTaskResultsFromRows(rows, store, { runId: 'r1' });
    expect(results[0]?.output).toBeUndefined();
    expect(results[0]?.summary).toBe('ran');
  });

  it('preserves metrics + summary alongside output', async () => {
    const store = makePayloadStore({ 'inline:exec': { score: 0.9 } });
    const rows = [
      task({
        taskId: 'execute',
        outputRef: 'inline:exec',
        metricsJson: { lbValue: 0.8 },
        summary: 'ensemble',
      }),
    ];
    const results = await buildEvalTaskResultsFromRows(rows, store, { runId: 'r1' });
    expect(results[0]?.output).toEqual({ score: 0.9 });
    expect(results[0]?.metrics).toEqual({ lbValue: 0.8 });
    expect(results[0]?.summary).toBe('ensemble');
  });

  it('skips output assignment when decoded payload is not a plain object', async () => {
    // Arrays / strings shouldn't be treated as Record<string, unknown>.
    const store = makePayloadStore({
      'inline:arr': [1, 2, 3],
      'inline:str': 'a raw string',
    });
    const rows = [
      task({ taskId: 'a', outputRef: 'inline:arr' }),
      task({ taskId: 'b', outputRef: 'inline:str' }),
    ];
    const results = await buildEvalTaskResultsFromRows(rows, store, { runId: 'r1' });
    expect(results[0]?.output).toBeUndefined();
    expect(results[1]?.output).toBeUndefined();
  });
});
