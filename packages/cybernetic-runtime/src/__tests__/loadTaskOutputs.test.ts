import { Buffer } from 'node:buffer';
import { describe, it, expect, vi } from 'vitest';
import { loadTaskOutputs, decodeTaskOutput } from '../humanTaskHydration.js';
import { computeReadyTasksWithWhen, collectOutputReferencedTaskIds } from '../scheduling/graph.js';
import type { WorkflowTask } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import type { WorkflowTaskRow } from '../ledger/types.js';

function makeRow(over: Partial<WorkflowTaskRow>): WorkflowTaskRow {
  return {
    id: 'row-id',
    runId: 'run-id',
    taskId: 'task',
    status: 'succeeded',
    attempt: 1,
    sessionId: null,
    workerSessionId: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    costCents: null,
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
    pollCycle: 1,
    ...over,
  };
}

function inlineRef(payload: Record<string, unknown>): string {
  return `inline:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

describe('decodeTaskOutput', () => {
  it('decodes inline refs without a PayloadStore', async () => {
    const ref = inlineRef({ foo: 'bar', n: 42 });
    const decoded = await decodeTaskOutput(ref, undefined);
    expect(decoded).toEqual({ foo: 'bar', n: 42 });
  });

  it('returns null for absent ref', async () => {
    expect(await decodeTaskOutput(null, undefined)).toBeNull();
  });

  it('returns null for non-inline ref when no PayloadStore is in scope', async () => {
    expect(await decodeTaskOutput('gs://bucket/key', undefined)).toBeNull();
  });

  it('decodes PayloadStore refs when a store is supplied', async () => {
    const store: Pick<PayloadStore, 'retrieve'> = {
      retrieve: vi.fn().mockResolvedValue({ submitted: true, decision: 'submit' }),
    };
    const decoded = await decodeTaskOutput('gs://bucket/key', store as PayloadStore);
    expect(decoded).toEqual({ submitted: true, decision: 'submit' });
  });

  it('decodes PayloadStore refs returning string JSON', async () => {
    const store: Pick<PayloadStore, 'retrieve'> = {
      retrieve: vi.fn().mockResolvedValue(JSON.stringify({ lbValue: 0.78 })),
    };
    const decoded = await decodeTaskOutput('gs://bucket/key', store as PayloadStore);
    expect(decoded).toEqual({ lbValue: 0.78 });
  });

  it('silently degrades on malformed inline ref', async () => {
    expect(await decodeTaskOutput('inline:not-base64', undefined)).toBeNull();
  });
});

describe('loadTaskOutputs', () => {
  it('only includes succeeded / completed tasks', async () => {
    const outputs = await loadTaskOutputs(
      [
        makeRow({ taskId: 'a', status: 'succeeded', outputRef: inlineRef({ x: 1 }) }),
        makeRow({ taskId: 'b', status: 'failed', outputRef: inlineRef({ x: 2 }) }),
        makeRow({ taskId: 'c', status: 'skipped', outputRef: inlineRef({ x: 3 }) }),
        makeRow({ taskId: 'd', status: 'blocked', outputRef: inlineRef({ x: 4 }) }),
      ],
      undefined,
    );
    expect(outputs.size).toBe(1);
    expect(outputs.get('a')).toEqual({ x: 1 });
  });

  it('mixes inline + PayloadStore refs in one run', async () => {
    const store: Pick<PayloadStore, 'retrieve'> = {
      retrieve: vi.fn().mockResolvedValue({ via: 'store' }),
    };
    const outputs = await loadTaskOutputs(
      [
        makeRow({ taskId: 'inline-task', outputRef: inlineRef({ via: 'inline' }) }),
        makeRow({ taskId: 'store-task', outputRef: 'gs://bucket/key' }),
      ],
      store as PayloadStore,
    );
    expect(outputs.get('inline-task')).toEqual({ via: 'inline' });
    expect(outputs.get('store-task')).toEqual({ via: 'store' });
  });
});

describe('collectOutputReferencedTaskIds', () => {
  function mkTask(taskId: string, when?: string): WorkflowTask {
    return {
      taskId,
      name: taskId,
      goal: 'g',
      ...(when ? { when: { expression: when, onMissingRef: 'skip' as const } } : {}),
    } as WorkflowTask;
  }

  it('returns empty when no task has a when-expression', () => {
    expect(collectOutputReferencedTaskIds([mkTask('a'), mkTask('b')])).toEqual(new Set());
  });

  it('returns empty when when-expressions only check status', () => {
    expect(
      collectOutputReferencedTaskIds([mkTask('a', "tasks.prepare.status == 'succeeded'")]),
    ).toEqual(new Set());
  });

  it('collects task IDs referenced by output predicates', () => {
    expect(
      collectOutputReferencedTaskIds([
        mkTask('a', 'tasks.prepare-submission.output.submitted == true'),
        mkTask('b', 'tasks.execute.output.cvScore > 0.8'),
      ]),
    ).toEqual(new Set(['prepare-submission', 'execute']));
  });

  it('handles multiple references in a single expression', () => {
    expect(
      collectOutputReferencedTaskIds([
        // (Phase 1 evaluator only supports single comparisons, but the
        // regex extractor is forward-compatible if the parser extends.)
        mkTask('a', 'tasks.alpha.output.x == tasks.beta.output.y'),
      ]),
    ).toEqual(new Set(['alpha', 'beta']));
  });
});

describe('computeReadyTasksWithWhen — output predicate evaluation', () => {
  function approveSubmitTask(): WorkflowTask {
    return {
      taskId: 'approve-submit',
      name: 'Approve submit',
      goal: 'approve',
      type: 'human',
      intent: 'approve',
      dependsOn: ['prepare-submission'],
      when: {
        expression: 'tasks.prepare-submission.output.submitted == true',
        onMissingRef: 'skip',
      },
    } as WorkflowTask;
  }

  it('passes when the upstream output makes the predicate true', () => {
    const result = computeReadyTasksWithWhen(
      [approveSubmitTask()],
      new Set(['prepare-submission']), // completed
      new Set(),
      {
        statuses: new Map([['prepare-submission', 'succeeded']]),
        outputs: new Map([['prepare-submission', { submitted: true, decision: 'submit' }]]),
      },
    );
    expect(result.ready.map((t) => t.taskId)).toEqual(['approve-submit']);
    expect(result.skipped).toEqual([]);
  });

  it('skips when the upstream output makes the predicate false', () => {
    const result = computeReadyTasksWithWhen(
      [approveSubmitTask()],
      new Set(['prepare-submission']),
      new Set(),
      {
        statuses: new Map([['prepare-submission', 'succeeded']]),
        outputs: new Map([['prepare-submission', { submitted: false, decision: 'skip_other' }]]),
      },
    );
    expect(result.ready).toEqual([]);
    expect(result.skipped.map((s) => s.task.taskId)).toEqual(['approve-submit']);
  });

  // The Pass 4 bug: outputs map is empty → predicate falls through to
  // onMissingRef: 'skip' → entire submit branch silently never runs.
  it('REGRESSION — empty outputs map silently skips (the Pass 4 bug)', () => {
    const result = computeReadyTasksWithWhen(
      [approveSubmitTask()],
      new Set(['prepare-submission']),
      new Set(),
      {
        statuses: new Map([['prepare-submission', 'succeeded']]),
        outputs: new Map(), // ← the Pass 4 buildTaskOutputContext behavior
      },
    );
    // Predicate sees no output → onMissingRef: 'skip' fires.
    expect(result.ready).toEqual([]);
    expect(result.skipped.map((s) => s.task.taskId)).toEqual(['approve-submit']);
  });
});
