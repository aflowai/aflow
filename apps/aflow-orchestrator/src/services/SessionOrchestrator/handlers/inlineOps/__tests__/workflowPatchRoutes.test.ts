import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowTaskRoute } from '@aflow/schemas';
import { convertWorkflowPatchToStagedOps } from '../workflowPatchToStagedOps.js';

const BILLING: WorkflowTaskRoute = {
  when: { expression: "output.answers.team.value == 'billing'" },
  enable: ['billing'],
};
const REFUND: WorkflowTaskRoute = {
  when: { expression: "output.answers.team.value == 'refund'" },
  enable: ['refund'],
};

const existing = {
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
      routes: [BILLING],
    },
    { taskId: 'billing', name: 'Billing', goal: 'Handle billing.', type: 'agent' },
  ],
  outcomes: [],
  iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
  stateVariables: [],
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
} as Workflow;

const refundTask = { taskId: 'refund', name: 'Refund', goal: 'Handle refunds.', type: 'agent' };

describe('a patch under a task’s routes is staged as its routes', () => {
  it('adds a branch as one task and one route', () => {
    const { ops, unsupported } = convertWorkflowPatchToStagedOps(
      [
        { op: 'add', path: '/tasks/-', value: refundTask },
        { op: 'add', path: '/tasks/0/routes/-', value: REFUND },
      ],
      existing,
    );
    expect(unsupported).toEqual([]);
    expect(ops).toEqual([
      { op: 'add_task', task: refundTask },
      { op: 'update_task_routes', taskId: 'triage', routes: [BILLING, REFUND] },
    ]);
  });

  it('extends what one route enables', () => {
    const { ops } = convertWorkflowPatchToStagedOps(
      [{ op: 'add', path: '/tasks/0/routes/0/enable/-', value: 'refund' }],
      existing,
    );
    expect(ops).toEqual([
      {
        op: 'update_task_routes',
        taskId: 'triage',
        routes: [{ ...BILLING, enable: ['billing', 'refund'] }],
      },
    ]);
  });

  it('stages an empty list when the routes are removed', () => {
    const { ops } = convertWorkflowPatchToStagedOps(
      [{ op: 'remove', path: '/tasks/0/routes' }],
      existing,
    );
    expect(ops).toEqual([{ op: 'update_task_routes', taskId: 'triage', routes: [] }]);
  });

  it('refuses a route that is not a route, naming the task', () => {
    const { unsupported } = convertWorkflowPatchToStagedOps(
      [{ op: 'add', path: '/tasks/0/routes/-', value: { when: 'x', enable: [] } }],
      existing,
    );
    expect(unsupported.join()).toContain('task "triage" with invalid routes');
  });
});
