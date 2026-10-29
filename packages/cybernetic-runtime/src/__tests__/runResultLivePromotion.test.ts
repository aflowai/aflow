import { describe, it, expect } from 'vitest';
import type { Workflow, WorkflowTask } from '@aflow/schemas';
import type { PromotionTaskResult } from '../promotion.js';
import { appendCoWriterTaskIds, resolveTaskPromotedState } from '../runResult.js';

function task(taskId: string, promoteOutputs: WorkflowTask['promoteOutputs']): WorkflowTask {
  return { taskId, promoteOutputs } as unknown as WorkflowTask;
}

const REVIEW = task('review', [
  { kind: 'output_path', path: 'findings', toState: 'findings' },
  { kind: 'output_path', path: 'verdict', toState: 'verdict' },
]);
const UNRELATED = task('unrelated', [{ kind: 'output_path', path: 'x', toState: 'x' }]);
const REPORT = task('report-setup', [
  { kind: 'output_path', path: 'finding', toState: 'findings' },
]);
const WORKFLOW = {
  tasks: [REVIEW, UNRELATED, REPORT],
  stateVariables: [
    { variableId: 'findings', writers: 'append', sensitive: false },
    { variableId: 'verdict', sensitive: false },
    { variableId: 'x', sensitive: false },
  ],
} as unknown as Pick<Workflow, 'tasks' | 'stateVariables'>;

const REVIEWED: PromotionTaskResult = {
  taskId: 'review',
  status: 'succeeded',
  output: { findings: [{ id: 'a' }, { id: 'b' }], verdict: 'approve' },
};
const REPORTED: PromotionTaskResult = {
  taskId: 'report-setup',
  status: 'succeeded',
  output: { finding: { id: 'setup' } },
};

describe('resolveTaskPromotedState — the live slice of an append variable', () => {
  it('names the co-writers of the append variables a task writes, and none for a task writing none', () => {
    expect(appendCoWriterTaskIds(REPORT, WORKFLOW)).toEqual(['review']);
    expect(appendCoWriterTaskIds(REVIEW, WORKFLOW)).toEqual(['report-setup']);
    expect(appendCoWriterTaskIds(UNRELATED, WORKFLOW)).toEqual([]);
  });

  it("shows both writer tasks' items live, in task-list order, whichever finished last", () => {
    // Applied in arrival order, as the run view does: a key's latest slice wins.
    let outputs: Record<string, unknown> = {};
    outputs = { ...outputs, ...resolveTaskPromotedState(REVIEW, REVIEWED, WORKFLOW) };
    expect(outputs['findings']).toEqual([{ id: 'a' }, { id: 'b' }]);
    outputs = {
      ...outputs,
      ...resolveTaskPromotedState(REPORT, REPORTED, WORKFLOW, [REVIEWED]),
    };
    expect(outputs['findings']).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'setup' }]);
    expect(outputs['verdict']).toBe('approve');

    // Finished the other way round, the join still keeps the task list's order.
    expect(resolveTaskPromotedState(REVIEW, REVIEWED, WORKFLOW, [REPORTED])).toEqual({
      findings: [{ id: 'a' }, { id: 'b' }, { id: 'setup' }],
      verdict: 'approve',
    });
  });

  it('joins only succeeded co-writers, and carries only the keys the task itself wrote', () => {
    const failed: PromotionTaskResult = { ...REVIEWED, status: 'failed' };
    expect(resolveTaskPromotedState(REPORT, REPORTED, WORKFLOW, [failed])).toEqual({
      findings: [{ id: 'setup' }],
    });
  });
});
