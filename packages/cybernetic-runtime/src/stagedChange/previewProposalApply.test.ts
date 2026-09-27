import { describe, it, expect } from 'vitest';
import { previewProposalApply } from './previewProposalApply.js';
import { applyOpsToSnapshot } from './applyOpsToSnapshot.js';
import type { CyberneticEvalSuite, StagedChangeOp, Workflow, WorkflowTask } from '@aflow/schemas';

// ============================================================================
// Fixtures
// ============================================================================

function task(taskId: string, opts?: Partial<WorkflowTask>): WorkflowTask {
  return {
    taskId,
    name: `Task ${taskId}`,
    goal: `Goal for ${taskId}`,
    type: 'agent',
    ...(opts as object),
  } as WorkflowTask;
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    slug: 'wf-test',
    name: 'Test Workflow',
    description: '',
    mode: 'process',
    revision: 3,
    status: 'approved',
    tasks: [
      task('a', { goal: 'goal-a' }),
      task('b', { goal: 'goal-b', dependsOn: ['a'] }),
      task('c', { goal: 'goal-c', dependsOn: ['b'] }),
    ],
    outcomes: [
      {
        id: 'out1',
        name: 'Outcome 1',
        evaluator: { type: 'manual', instruction: 'check' },
      } as never,
    ],
    iteration: { maxConsecutiveRuns: 5 } as never,
    stateVariables: [],
    createdAt: '2026-05-13T00:00:00.000Z',
    updatedAt: '2026-05-13T00:00:00.000Z',
    ...overrides,
  } as Workflow;
}

function makeEvalSuite(overrides: Partial<CyberneticEvalSuite> = {}): CyberneticEvalSuite {
  return {
    version: 1,
    skillSlug: 'wf',
    createdAt: '2026-05-13T00:00:00.000Z',
    updatedAt: '2026-05-13T00:00:00.000Z',
    createdBy: 'test',
    goalCriteria: [
      { name: 'goal-crit-1', type: 'contains', inField: 'output', pattern: 'check' } as never,
    ],
    trajectoryCriteria: [],
    taskCriteria: {},
    ...overrides,
  } as CyberneticEvalSuite;
}

// ============================================================================
// Happy path
// ============================================================================

describe('previewProposalApply — happy path', () => {
  it('returns ok with bumped revision when ops apply cleanly', () => {
    const workflow = makeWorkflow();
    const ops: StagedChangeOp[] = [
      { op: 'update_task_goal', taskId: 'a', newGoal: 'new goal A' } as StagedChangeOp,
    ];
    const result = previewProposalApply({
      workflow,
      evalSuites: new Map(),
      ops,
      targetSlug: 'wf',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidateWorkflow?.revision).toBe(4);
    expect(result.candidateWorkflow?.tasks[0]?.goal).toBe('new goal A');
    expect(result.workflowRevisionAtPreview).toBe(4);
    // Original workflow MUST be unchanged — the transform is pure.
    expect(workflow.revision).toBe(3);
    expect(workflow.tasks[0]?.goal).toBe('goal-a');
  });

  it('returns ok for eval-only proposals (no workflow change)', () => {
    const suite = makeEvalSuite();
    const ops: StagedChangeOp[] = [
      {
        op: 'eval.criterion.add',
        skillSlug: 'wf',
        criterion: { name: 'new-crit', type: 'contains', inField: 'output', pattern: 'check' },
      } as StagedChangeOp,
    ];
    const result = previewProposalApply({
      workflow: makeWorkflow(),
      evalSuites: new Map([['wf', suite]]),
      ops,
      targetSlug: 'wf',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidateEvalSuites.get('wf')?.goalCriteria).toHaveLength(2);
    // Original suite untouched.
    expect(suite.goalCriteria).toHaveLength(1);
  });
});

// ============================================================================
// Per-failure-code fixture suite
// ============================================================================

describe('previewProposalApply — per-failure-code coverage', () => {
  it('rejects update_task_goal on a missing task with a structured failureCode', () => {
    const result = previewProposalApply({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      ops: [{ op: 'update_task_goal', taskId: 'does-not-exist', newGoal: 'x' } as StagedChangeOp],
      targetSlug: 'wf',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe('target_missing');
    expect(result.failedOpIndex).toBe(0);
  });

  it('rejects add_task with a dependsOn pointing at an unknown task', () => {
    const newTask: WorkflowTask = task('d', { dependsOn: ['ghost'] });
    const result = previewProposalApply({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      ops: [{ op: 'add_task', task: newTask } as StagedChangeOp],
      targetSlug: 'wf',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureDetail).toMatch(/ghost/);
  });

  it('rejects a duplicate add_task', () => {
    const newTask: WorkflowTask = task('a', { dependsOn: ['b'] });
    const result = previewProposalApply({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      ops: [{ op: 'add_task', task: newTask } as StagedChangeOp],
      targetSlug: 'wf',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureDetail).toMatch(/already exists/);
  });

  it('rejects a self-dependency cycle introduced by update_task_dependencies', () => {
    const result = previewProposalApply({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      ops: [{ op: 'update_task_dependencies', taskId: 'b', dependsOn: ['b'] } as StagedChangeOp],
      targetSlug: 'wf',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureDetail).toMatch(/cannot depend on itself/);
  });

  it('rejects eval.criterion.remove for a non-existent criterion', () => {
    const result = previewProposalApply({
      workflow: makeWorkflow(),
      evalSuites: new Map([['wf', makeEvalSuite()]]),
      ops: [
        { op: 'eval.criterion.remove', skillSlug: 'wf', criterionId: 'ghost' } as StagedChangeOp,
      ],
      targetSlug: 'wf',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe('eval_target_missing');
  });

  it('rejects an eval-suite proposal when the suite is missing', () => {
    const result = previewProposalApply({
      workflow: makeWorkflow(),
      evalSuites: new Map(), // no suite loaded
      ops: [
        {
          op: 'eval.criterion.remove',
          skillSlug: 'wf',
          criterionId: 'goal-crit-1',
        } as StagedChangeOp,
      ],
      targetSlug: 'wf',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe('target_skill_missing');
  });

  it('rejects an update_outcome_threshold for an unknown outcome', () => {
    const result = previewProposalApply({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      ops: [
        {
          op: 'update_outcome_threshold',
          outcomeId: 'ghost-outcome',
          newTarget: 0.9,
        } as StagedChangeOp,
      ],
      targetSlug: 'wf',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureCode).toBe('target_missing');
  });
});

// ============================================================================

describe('previewProposalApply — purity tripwire', () => {
  it('fails closed with preview_impure when applyOpsToSnapshot throws unexpectedly', () => {
    // Construct a malformed op that the per-op switch can't classify.
    // The exhaustive-switch guard throws inside applyWorkflowOp; the
    // pure transform should not crash the preview — it should return
    // a structured error. Verify that path by passing an unknown shape.
    const malformedOp = { op: 'no-such-op-kind' } as unknown as StagedChangeOp;
    const result = previewProposalApply({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      ops: [malformedOp],
      targetSlug: 'wf',
    });
    // The exhaustive switch lands in default: throw — applyOpsToSnapshot
    // catches the per-op throw and surfaces a structured failureCode,
    // not a JS throw. Either way, the preview must NEVER throw.
    expect(result.ok).toBe(false);
  });
});

// ============================================================================

describe('applyOpsToSnapshot — purity', () => {
  it('does not mutate the input workflow snapshot', () => {
    const workflow = makeWorkflow();
    const before = JSON.stringify(workflow);
    applyOpsToSnapshot({
      workflow,
      evalSuites: new Map(),
      ops: [{ op: 'update_task_goal', taskId: 'a', newGoal: 'mutated' } as StagedChangeOp],
      targetSlug: 'wf',
    });
    expect(JSON.stringify(workflow)).toBe(before);
  });

  it('does not mutate the input eval suite map', () => {
    const suite = makeEvalSuite();
    const before = JSON.stringify(suite);
    applyOpsToSnapshot({
      workflow: makeWorkflow(),
      evalSuites: new Map([['wf', suite]]),
      ops: [
        {
          op: 'eval.criterion.add',
          skillSlug: 'wf',
          criterion: { name: 'new-crit', description: 'd', weight: 1 },
        } as StagedChangeOp,
      ],
      targetSlug: 'wf',
    });
    expect(JSON.stringify(suite)).toBe(before);
  });
});
