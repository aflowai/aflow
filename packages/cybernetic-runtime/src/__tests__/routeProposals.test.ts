import { describe, expect, it } from 'vitest';
import type { StagedChangeOp, Workflow, WorkflowTaskRoute } from '@aflow/schemas';
import { applyOpsToSnapshot } from '../stagedChange/applyOpsToSnapshot.js';
import { buildProposalOpDiffs } from '../proposalOpDiff.js';

const BILLING: WorkflowTaskRoute = {
  when: { expression: "output.answers.team.value == 'billing'" },
  enable: ['billing'],
};
const REFUND: WorkflowTaskRoute = {
  when: { anyOf: ["output.answers.team.value == 'refund'", 'output.answers.urgent.value == true'] },
  enable: ['refund'],
};

function workflow(): Workflow {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    slug: 'triage',
    name: 'Triage',
    description: '',
    mode: 'process',
    revision: 1,
    status: 'approved',
    tasks: [
      {
        taskId: 'triage',
        name: 'Triage',
        goal: 'Run ai.decision.decide.',
        type: 'operation',
        operation: 'ai.decision.decide',
        inputTemplate: {
          state: 'A ticket',
          questions: {
            team: { type: 'choice', options: { billing: null, refund: null } },
            urgent: { type: 'yes_no' },
          },
        },
        routes: [BILLING],
      },
      {
        taskId: 'billing',
        name: 'Billing',
        goal: 'Handle billing.',
        type: 'agent',
        dependsOn: ['triage'],
      },
      {
        taskId: 'refund',
        name: 'Refund',
        goal: 'Handle refunds.',
        type: 'agent',
        dependsOn: ['triage'],
      },
    ],
    outcomes: [
      { id: 'routed', name: 'Routed', evaluator: { type: 'manual', instruction: 'Routed.' } },
    ],
    iteration: { maxConsecutiveRuns: 1 } as never,
    stateVariables: [],
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
  } as Workflow;
}

function apply(routes: WorkflowTaskRoute[]) {
  const result = applyOpsToSnapshot({
    workflow: workflow(),
    evalSuites: new Map(),
    ops: [{ op: 'update_task_routes', taskId: 'triage', routes } as StagedChangeOp],
    targetSlug: 'triage',
  });
  if (!result.ok) throw new Error(result.failureDetail);
  return result.ok ? result.candidateWorkflow?.tasks.find((t) => t.taskId === 'triage') : undefined;
}

describe('a route change ratified onto a workflow', () => {
  it('sets the task’s routes to the proposed list', () => {
    expect(apply([BILLING, REFUND])?.routes).toEqual([BILLING, REFUND]);
  });

  it('removes the field when the list is empty', () => {
    expect(apply([])).not.toHaveProperty('routes');
  });
});

describe('removing a task a route still enables', () => {
  it('is refused, naming the route that points at it', () => {
    const result = applyOpsToSnapshot({
      workflow: workflow(),
      evalSuites: new Map(),
      ops: [{ op: 'remove_task', taskId: 'billing' } as StagedChangeOp],
      targetSlug: 'triage',
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.failureDetail).toContain(
      'Task "triage" routes[0] enables "billing", which is not a task in this workflow.',
    );
  });
});

describe('a route change on the proposal card', () => {
  it('reads as the routes added and removed', () => {
    const [diff] = buildProposalOpDiffs(workflow(), [
      { op: 'update_task_routes', taskId: 'triage', routes: [REFUND] } as StagedChangeOp,
    ]);
    expect(diff?.entries).toEqual([
      { field: 'route', before: "when output.answers.team.value == 'billing' → enable billing" },
      {
        field: 'route',
        after:
          "when output.answers.team.value == 'refund' or output.answers.urgent.value == true → enable refund",
      },
    ]);
  });
});
