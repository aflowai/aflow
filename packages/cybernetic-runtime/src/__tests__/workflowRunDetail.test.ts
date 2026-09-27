import { describe, it, expect } from 'vitest';
import type { WorkflowTask } from '@aflow/schemas';

import {
  deriveSurfaceTaskType,
  extractWorkflowGraphHint,
  sanitizePriorFailures,
} from '../workflowRunDetail.js';

/** Minimal valid task fixture; override the dispatch-family fields per case. */
function makeTask(overrides: Partial<WorkflowTask>): WorkflowTask {
  return {
    taskId: 't',
    name: 'Task',
    goal: 'do the thing',
    ...overrides,
  } as WorkflowTask;
}

describe('extractWorkflowGraphHint', () => {
  it('returns graphFidelity="full" + taskIds + edges when the definition covers every recorded task', () => {
    const defTasks = [
      { taskId: 'prepare', name: 'Prepare data', dependsOn: [], operation: 'memory.store.get' },
      { taskId: 'train', name: 'Train model', dependsOn: ['prepare'], agent: 'runner' },
      {
        taskId: 'evaluate',
        name: 'Evaluate',
        dependsOn: ['train'],
        pauseInstruction: 'Approve?',
        intent: 'approve' as const,
      },
    ];
    const recorded = ['prepare', 'train'];

    const result = extractWorkflowGraphHint(defTasks, recorded);

    expect(result.graphFidelity).toBe('full');
    expect(result.workflowGraph).toBeDefined();
    expect(result.workflowGraph?.taskIds).toEqual(['prepare', 'train', 'evaluate']);
    expect(result.workflowGraph?.edges).toEqual([
      { from: 'prepare', to: 'train' },
      { from: 'train', to: 'evaluate' },
    ]);
    expect(result.workflowGraph?.taskHints).toEqual([
      {
        taskId: 'prepare',
        label: 'Prepare data',
        taskType: 'operation',
        operationId: 'memory.store.get',
      },
      {
        taskId: 'train',
        label: 'Train model',
        taskType: 'agent',
        operationId: 'ai.agent.turn',
      },
      {
        taskId: 'evaluate',
        label: 'Evaluate',
        taskType: 'human',
        humanIntent: 'approve',
      },
    ]);
  });

  it('handles multi-parent edges (fan-in)', () => {
    const defTasks = [
      { taskId: 'a', dependsOn: [] },
      { taskId: 'b', dependsOn: [] },
      { taskId: 'merge', dependsOn: ['a', 'b'] },
    ];
    const result = extractWorkflowGraphHint(defTasks, ['a', 'b']);

    expect(result.graphFidelity).toBe('full');
    expect(result.workflowGraph?.edges).toEqual([
      { from: 'a', to: 'merge' },
      { from: 'b', to: 'merge' },
    ]);
  });

  it('returns graphFidelity="degraded" + no graph when a recorded task is missing from the definition', () => {
    const defTasks = [{ taskId: 'prepare', dependsOn: [] }];
    // Run executed an old task `legacy` that the current definition no
    // longer names. Forward-DAG rendering would be misleading.
    const recorded = ['prepare', 'legacy'];

    const result = extractWorkflowGraphHint(defTasks, recorded);

    expect(result.graphFidelity).toBe('degraded');
    expect(result.workflowGraph).toBeUndefined();
  });

  it('returns graphFidelity="full" with empty edges when no task has dependsOn', () => {
    const defTasks = [{ taskId: 'standalone' }];
    const result = extractWorkflowGraphHint(defTasks, ['standalone']);
    expect(result.graphFidelity).toBe('full');
    expect(result.workflowGraph?.taskIds).toEqual(['standalone']);
    expect(result.workflowGraph?.edges).toEqual([]);
  });

  it('treats an empty recorded list as fully covered (forward-only run, nothing executed yet)', () => {
    const defTasks = [
      { taskId: 'a', dependsOn: [] },
      { taskId: 'b', dependsOn: ['a'] },
    ];
    const result = extractWorkflowGraphHint(defTasks, []);
    expect(result.graphFidelity).toBe('full');
    expect(result.workflowGraph?.taskIds).toEqual(['a', 'b']);
  });

  it('carries a display-ready when view on guarded task hints', () => {
    const defTasks = [
      { taskId: 'plan-approve', dependsOn: [], intent: 'approve' as const },
      {
        taskId: 'implement',
        name: 'Implement',
        dependsOn: ['plan-approve'],
        agent: 'runner',
        when: {
          expression: "tasks.plan-approve.output.decision == 'approved'",
          onMissingRef: 'skip' as const,
        },
      },
      {
        taskId: 'push',
        dependsOn: ['implement'],
        operation: 'code.repo.push',
        when: {
          allOf: [
            "tasks.plan-approve.output.decision == 'approved'",
            "tasks.implement.output.status == 'succeeded'",
          ],
          onMissingRef: 'error' as const,
        },
      },
    ];
    const result = extractWorkflowGraphHint(defTasks, []);
    const hints = new Map(result.workflowGraph?.taskHints?.map((h) => [h.taskId, h]));
    expect(hints.get('plan-approve')?.when).toBeUndefined();
    expect(hints.get('implement')?.when).toEqual({
      mode: 'single',
      clauses: ["plan-approve.output.decision == 'approved'"],
      onMissingRef: 'skip',
    });
    expect(hints.get('push')?.when).toEqual({
      mode: 'all',
      clauses: [
        "plan-approve.output.decision == 'approved'",
        "implement.output.status == 'succeeded'",
      ],
      onMissingRef: 'error',
    });
  });
});

describe('deriveSurfaceTaskType', () => {
  it('uses inferTaskType when the workflow definition resolves', () => {
    expect(deriveSurfaceTaskType({ taskDef: makeTask({ agent: 'runner' }) })).toBe('agent');
    expect(deriveSurfaceTaskType({ taskDef: makeTask({ operation: 'workflow.learn' }) })).toBe(
      'operation',
    );
    expect(
      deriveSurfaceTaskType({
        taskDef: makeTask({ pauseInstruction: 'Approve?', intent: 'approve' }),
      }),
    ).toBe('human');
  });

  it('falls back to operationId when the definition is gone (drift)', () => {
    // Agent tasks dispatch ai.agent.turn.
    expect(deriveSurfaceTaskType({ operationId: 'ai.agent.turn' })).toBe('agent');
    // Any other recorded op id ⇒ operation.
    expect(deriveSurfaceTaskType({ operationId: 'workflow.learn' })).toBe('operation');
  });

  it('infers human from a hydration/decision signal when there is no op id', () => {
    // A human row records no operationId; the durable hydration / resolved
    // decision is the only "this is human" hint once the definition drifts.
    expect(deriveSurfaceTaskType({ looksHuman: true })).toBe('human');
  });

  it('returns undefined when nothing identifies the task', () => {
    expect(deriveSurfaceTaskType({})).toBeUndefined();
  });
});

describe('sanitizePriorFailures (Plan 206 — run-detail read-path hardening)', () => {
  const FALLBACK = '2026-06-17T00:00:00.000Z';

  it('coerces a producer-rerun entry missing failedAt (so it cannot 500 the response)', () => {
    const out = sanitizePriorFailures(
      [
        {
          kind: 'producer_contract_rerun',
          consumerTaskId: 'validate-task-graph',
          bindAs: 'draft',
          producerTaskId: 'draft-task-graph',
          contractName: 'compose-input-schema',
          attempt: 1,
          failureReason: 'x',
        },
      ],
      FALLBACK,
    );
    expect(out).toHaveLength(1);
    expect(out![0]!.failedAt).toBe(FALLBACK);
    expect(out![0]!.attempt).toBe(1);
    // Non-DTO fields are stripped by safeParse.
    expect((out![0] as Record<string, unknown>)['kind']).toBeUndefined();
    expect((out![0] as Record<string, unknown>)['bindAs']).toBeUndefined();
  });

  it("keeps a well-formed entry verbatim (entry's own failedAt wins over the fallback)", () => {
    const out = sanitizePriorFailures(
      [{ attempt: 2, failedAt: '2026-01-01T00:00:00.000Z', errorCode: 'X' }],
      FALLBACK,
    );
    expect(out).toEqual([{ attempt: 2, failedAt: '2026-01-01T00:00:00.000Z', errorCode: 'X' }]);
  });

  it('drops unsalvageable entries (missing attempt, non-objects) instead of throwing', () => {
    const out = sanitizePriorFailures(
      [{ failureReason: 'no attempt' }, { foo: 1 }, null, 'x', 42],
      FALLBACK,
    );
    expect(out).toBeUndefined();
  });

  it('returns undefined for empty / non-array input', () => {
    expect(sanitizePriorFailures([], FALLBACK)).toBeUndefined();
    expect(sanitizePriorFailures(undefined, FALLBACK)).toBeUndefined();
    expect(sanitizePriorFailures(null, FALLBACK)).toBeUndefined();
  });
});
