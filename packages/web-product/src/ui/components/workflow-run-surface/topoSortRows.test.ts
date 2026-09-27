import { describe, expect, it } from 'vitest';
import { topoSortRows } from './workflowRunSurfaceHelpers.js';
import type { WorkflowSurfaceGraph, WorkflowSurfaceTaskState } from '../../lib/types.js';

function task(overrides: Partial<WorkflowSurfaceTaskState>): WorkflowSurfaceTaskState {
  return {
    taskId: 't',
    label: 'Task',
    status: 'succeeded',
    attempt: 1,
    lastMutatedAtMs: 0,
    ...overrides,
  };
}

const WHEN = {
  mode: 'single' as const,
  clauses: ["plan-approve.output.decision == 'approved'"],
  onMissingRef: 'skip' as const,
};

const GRAPH: WorkflowSurfaceGraph = {
  taskIds: ['plan-approve', 'implement', 'push'],
  edges: [
    { from: 'plan-approve', to: 'implement' },
    { from: 'implement', to: 'push' },
  ],
  taskHints: [
    { taskId: 'plan-approve', label: 'Approve plan', taskType: 'human', humanIntent: 'approve' },
    { taskId: 'implement', label: 'Implement', taskType: 'agent', when: WHEN },
    {
      taskId: 'push',
      label: 'Push',
      taskType: 'operation',
      operationId: 'code.repo.push',
      when: {
        mode: 'all',
        clauses: [
          "plan-approve.output.decision == 'approved'",
          "implement.output.status == 'succeeded'",
        ],
        onMissingRef: 'skip',
      },
    },
  ],
};

describe('topoSortRows when-guard threading', () => {
  it('sets `when` on forward rows from the graph hint', () => {
    const rows = topoSortRows([task({ taskId: 'plan-approve', label: 'Approve plan' })], GRAPH);
    const byId = new Map(rows.map((r) => [r.taskId, r]));
    expect(byId.get('implement')?.forward).toBe(true);
    expect(byId.get('implement')?.when).toEqual(WHEN);
    expect(byId.get('push')?.when?.mode).toBe('all');
    expect(byId.get('plan-approve')?.when).toBeUndefined();
  });

  it('backfills `when` on recorded rows so skipped/executed rows can show their guard', () => {
    const rows = topoSortRows(
      [
        task({ taskId: 'plan-approve', label: 'Approve plan' }),
        task({ taskId: 'implement', label: 'Implement', status: 'skipped' }),
      ],
      GRAPH,
    );
    const implement = rows.find((r) => r.taskId === 'implement');
    expect(implement?.forward).toBe(false);
    expect(implement?.when).toEqual(WHEN);
  });

  it('leaves `when` unset without a graph', () => {
    const rows = topoSortRows([task({ taskId: 'implement' })], undefined);
    expect(rows[0]?.when).toBeUndefined();
  });
});
