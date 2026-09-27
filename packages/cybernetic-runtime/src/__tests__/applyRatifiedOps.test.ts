/**
 * Tests for applyRatifiedOps — 104e follow-up Phase A.
 *
 * Uses in-memory mocks for the memory-doc repository to test the
 * op-dispatch logic without a database. Integration tests for the
 * full ratify → apply → causal-binder pipeline live in the server tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Workflow, CyberneticEvalSuite, StagedChange } from '@aflow/schemas';
import { StagedChangeOpSchema } from '@aflow/schemas';
import { computeProposalPreconditions } from '../stagedChange/preconditions.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeWorkflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'test-skill',
    name: 'Test Skill',
    description: '',
    goal: 'Solve the problem',
    outcomes: [
      {
        id: 'outcome-1',
        name: 'Outcome 1',
        evaluator: {
          type: 'threshold' as const,
          metric: 'accuracy',
          operator: 'gte' as const,
          target: 0.8,
        },
      },
    ],
    mode: 'optimization' as const,
    tasks: [
      { taskId: 'task-a', name: 'Task A', goal: 'Do task A', type: 'agent' as const },
      {
        taskId: 'task-b',
        name: 'Task B',
        goal: 'Do task B',
        type: 'agent' as const,
        dependsOn: ['task-a'],
      },
    ],
    iteration: { auto: false, maxConsecutiveRuns: 5, stopOnOutcomesMet: true, cooldownMs: 0 },
    revision: 3,
    status: 'approved' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEvalSuite(overrides?: Partial<CyberneticEvalSuite>): CyberneticEvalSuite {
  return {
    goalCriteria: [
      {
        type: 'threshold' as const,
        name: 'accuracy-check',
        metric: 'accuracy',
        operator: 'gte' as const,
        target: 0.7,
      },
      {
        type: 'threshold' as const,
        name: 'latency-check',
        metric: 'latency',
        operator: 'lte' as const,
        target: 1000,
      },
    ],
    taskCriteria: {},
    trajectoryCriteria: [],
    weights: { goal: 0.4, task: 0.4, trajectory: 0.2 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'platform',
    ...overrides,
  };
}

function makeStagedChange(
  ops: StagedChange['proposal']['ops'],
  overrides?: Partial<StagedChange> & { __skipPreconditions?: boolean },
): StagedChange {
  const slug = overrides?.targetWorkflowSlug ?? 'test-skill';
  const kind = overrides?.kind ?? 'workflow_refinement';
  const base: StagedChange = {
    id: '00000000-0000-0000-0000-000000000099',
    kind: kind as StagedChange['kind'],
    status: 'proposed',
    targetWorkflowSlug: slug,
    proposal: {
      summary: 'Test proposal',
      rationale: 'Test rationale',
      confidence: 'high',
      ops,
    },
    evidence: { sourceSessionIds: [] },
    authorityLevel: 'auto_apply',
    resolutionRoute: 'tenant_ratification',
    proposedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z',
    coachSessionId: '00000000-0000-0000-0000-000000000002',
    rebaseState: 'clean',
    ...overrides,
  };

  if (
    !overrides?.__skipPreconditions &&
    !overrides?.preconditions &&
    (kind === 'workflow_refinement' || kind === 'eval_criterion_change')
  ) {
    const wfJson = mockDocs.get(`/workflows/${slug}/workflow.json`);
    const suiteJson = mockDocs.get(`/evals/${slug}/suite.json`);
    if (wfJson || suiteJson) {
      const workflow = wfJson ? (JSON.parse(wfJson) as Workflow) : null;
      const evalSuites = new Map<string, CyberneticEvalSuite>();
      if (suiteJson) evalSuites.set(slug, JSON.parse(suiteJson) as CyberneticEvalSuite);
      const pins = computeProposalPreconditions(base, { workflow, evalSuites });
      if (pins) base.preconditions = pins;
      if (workflow) base.pinnedRevision = workflow.revision;
    }
  }
  return base;
}

// ============================================================================
// Mock the database layer
// ============================================================================

const mockDocs = new Map<string, string>();

function makeMockRepo() {
  const repo = {
    getByPath: async (path: string) => {
      const content = mockDocs.get(path);
      if (!content) return null;
      return { inlineContent: content, path };
    },
    put: async (opts: { path: string; inlineContent: string }) => {
      mockDocs.set(opts.path, opts.inlineContent);
      return { id: 'doc-id', path: opts.path, currentVersion: 1 };
    },
    withTransaction: async <T>(fn: (txRepo: ReturnType<typeof makeMockRepo>) => Promise<T>) => {
      return fn(repo);
    },
  };
  return repo;
}

vi.mock('@aflow/database', () => ({
  createTenantContext: () => ({ schema: 'test' }),
  createMemoryDocRepository: () => makeMockRepo(),
  workflowDocPath: (slug: string) => `/workflows/${slug}/workflow.json`,
  workflowRevisionPath: (slug: string, revision: number) =>
    `/workflows/${slug}/revisions/workflow-r${String(revision)}.json`,
  ensureWorkflowRevisionSnapshot: async (params: {
    slug: string;
    revision: number;
    workflow: Record<string, unknown>;
  }) => {
    const path = `/workflows/${params.slug}/revisions/workflow-r${String(params.revision)}.json`;
    mockDocs.set(path, JSON.stringify(params.workflow, null, 2));
    return 'created';
  },
}));

vi.mock('../logger.js', () => ({
  getCyberneticLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

// Import after mocks
const { applyRatifiedOps, RatificationApplyError } =
  await import('../stagedChange/applyRatifiedOps.js');

const ctx = {
  tenantId: 'tenant-1',
  spaceId: 'space-1',
  db: {} as never,
};

// ============================================================================
// Tests — Workflow mutations
// ============================================================================

describe('applyRatifiedOps — workflow mutations', () => {
  beforeEach(() => {
    mockDocs.clear();
  });

  it('rejects ops on platform-owned workflow with platform_artifact_read_only (Plan 115)', async () => {
    // Even if a stale StagedChange targeting a platform workflow slipped past
    // proposal.ratify's earlier check, applyRatifiedOps must refuse to mutate.
    const sc = makeStagedChange(
      [{ op: 'update_task_goal', taskId: 'draft-evals', newGoal: 'fix shape' }],
      { targetWorkflowSlug: 'compose-skill', resolutionRoute: 'platform_issue' },
    );

    await expect(applyRatifiedOps(ctx, sc)).rejects.toMatchObject({
      name: 'RatificationApplyError',
      op: 'platform_artifact_read_only',
      reason: 'platform_artifact_read_only',
    });

    // No workflow doc was written
    expect(mockDocs.has('/workflows/compose-skill/workflow.json')).toBe(false);
  });

  it('update_task_goal mutates workflow and bumps revision', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([
      { op: 'update_task_goal', taskId: 'task-a', newGoal: 'Updated goal for A' },
    ]);

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    expect(result.appliedOps).toContain('update_task_goal');
    expect(result.newRevision).toBe(4);

    // Check the workflow was persisted with the updated goal
    const updatedJson = mockDocs.get('/workflows/test-skill/workflow.json');
    expect(updatedJson).toBeDefined();
    const updated = JSON.parse(updatedJson!);
    const taskA = updated.tasks.find((t: { taskId: string }) => t.taskId === 'task-a');
    expect(taskA.goal).toBe('Updated goal for A');
    expect(updated.revision).toBe(4);

    // Check prior revision was saved
    const priorJson = mockDocs.get('/workflows/test-skill/revisions/workflow-r3.json');
    expect(priorJson).toBeDefined();
    const prior = JSON.parse(priorJson!);
    expect(prior.revision).toBe(3);
  });

  it('remove_task removes the task from workflow', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([{ op: 'remove_task', taskId: 'task-b' }]);

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    const updated = JSON.parse(mockDocs.get('/workflows/test-skill/workflow.json')!);
    expect(updated.tasks).toHaveLength(1);
    expect(updated.tasks[0].taskId).toBe('task-a');
  });

  it('reorder_tasks reorders tasks', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([{ op: 'reorder_tasks', taskIds: ['task-b', 'task-a'] }]);

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    const updated = JSON.parse(mockDocs.get('/workflows/test-skill/workflow.json')!);
    expect(updated.tasks[0].taskId).toBe('task-b');
    expect(updated.tasks[1].taskId).toBe('task-a');
  });

  it('update_outcome_threshold patches outcome evaluator target', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([
      { op: 'update_outcome_threshold', outcomeId: 'outcome-1', newTarget: 0.95 },
    ]);

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    const updated = JSON.parse(mockDocs.get('/workflows/test-skill/workflow.json')!);
    expect(updated.outcomes[0].evaluator.target).toBe(0.95);
  });

  it('update_iteration_policy patches iteration fields', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([
      { op: 'update_iteration_policy', maxConsecutiveRuns: 10, cooldownMs: 5000 },
    ]);

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    const updated = JSON.parse(mockDocs.get('/workflows/test-skill/workflow.json')!);
    expect(updated.iteration.maxConsecutiveRuns).toBe(10);
    expect(updated.iteration.cooldownMs).toBe(5000);
    expect(updated.iteration.stopOnOutcomesMet).toBe(true);
  });

  it('add_task adds a fully-specified agent task with upstream dependency', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([
      {
        op: 'add_task',
        task: {
          taskId: 'task-c',
          name: 'Task C',
          goal: 'New task C',
          type: 'agent' as const,
          dependsOn: ['task-b'],
        },
      },
    ]);

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    const updated = JSON.parse(mockDocs.get('/workflows/test-skill/workflow.json')!);
    expect(updated.tasks).toHaveLength(3);
    const taskC = updated.tasks.find((t: { taskId: string }) => t.taskId === 'task-c');
    expect(taskC).toBeDefined();
    expect(taskC.goal).toBe('New task C');
    expect(taskC.type).toBe('agent');
    expect(taskC.dependsOn).toEqual(['task-b']);
  });

  it('add_task rejects a task with no dispatch family at parse time', () => {
    const sc = {
      proposal: {
        ops: [
          {
            op: 'add_task',
            task: { taskId: 'bad', name: 'Bad', goal: 'No type' },
          },
        ],
      },
    };
    // Use the schema directly to verify the parse-time rejection.
    // The full StagedChange schema would also reject this; we keep this
    // test focused on the dispatch-family invariant.
    expect(() => StagedChangeOpSchema.parse(sc.proposal.ops[0])).toThrow();
  });

  it('add_task rejects a new source task without explicit source: true', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([
      {
        op: 'add_task',
        task: {
          taskId: 'task-c',
          name: 'Task C',
          goal: 'Source task without opt-in',
          type: 'agent' as const,
        },
      },
    ]);

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow(/op\.source/);
  });

  it('add_task with source: true is rejected when a root task already exists (multiple_root_tasks)', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([
      {
        op: 'add_task',
        source: true,
        task: {
          taskId: 'task-c',
          name: 'Task C',
          goal: 'New source task',
          type: 'agent' as const,
        },
      },
    ]);

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow(/multiple_root_tasks/);
  });

  it('add_task with source: true is valid when replacing the only existing task', async () => {
    // Single-task workflow: just task-a with no downstream tasks.
    const singleTaskWf = {
      ...makeWorkflow(),
      tasks: [{ taskId: 'task-a', name: 'Task A', goal: 'Do task A', type: 'agent' as const }],
    };
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(singleTaskWf));

    // Remove task-a and add task-c as the sole root — result has exactly one root.
    const sc = makeStagedChange([
      { op: 'remove_task', taskId: 'task-a' },
      {
        op: 'add_task',
        source: true,
        task: {
          taskId: 'task-c',
          name: 'Task C',
          goal: 'New sole root',
          type: 'agent' as const,
        },
      },
    ]);

    const result = await applyRatifiedOps(ctx, sc);
    expect(result.applied).toBe(true);
  });

  it('add_task rejects dependsOn pointing to a non-existent task', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([
      {
        op: 'add_task',
        task: {
          taskId: 'task-c',
          name: 'Task C',
          goal: 'Hangs off ghost',
          type: 'agent' as const,
          dependsOn: ['ghost'],
        },
      },
    ]);

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow(/does not exist/);
  });

  it('update_task_dependencies inserts a gate between two tasks', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([
      {
        op: 'add_task',
        task: {
          taskId: 'gate',
          name: 'Gate',
          goal: 'Validate before continuing',
          type: 'agent' as const,
          dependsOn: ['task-a'],
        },
      },
      { op: 'update_task_dependencies', taskId: 'task-b', dependsOn: ['gate'] },
    ]);

    const result = await applyRatifiedOps(ctx, sc);
    expect(result.applied).toBe(true);

    const updated = JSON.parse(mockDocs.get('/workflows/test-skill/workflow.json')!);
    const taskB = updated.tasks.find((t: { taskId: string }) => t.taskId === 'task-b');
    expect(taskB.dependsOn).toEqual(['gate']);
  });

  it('update_task_dependencies rejects clearing deps without source: true', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([
      { op: 'update_task_dependencies', taskId: 'task-b', dependsOn: [] },
    ]);

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow(/op\.source/);
  });

  it('platform_issue is a no-op', async () => {
    const sc = makeStagedChange(
      [{ op: 'platform_issue', subjectKind: 'runtime' as const, summary: 'Something is wrong' }],
      { kind: 'platform_issue' },
    );

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(false);
    expect(result.skippedOps).toContain('platform_issue');
  });

  it('amend_directives is skipped (handled by directive route)', async () => {
    const sc = makeStagedChange(
      [
        {
          op: 'amend_directives',
          changedPaths: ['scope.responsibility'],
          proposedDirectives: {},
          priorDirectives: null,
        },
      ],
      { kind: 'directive_amendment' },
    );

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(false);
    expect(result.skippedOps).toContain('amend_directives');
  });
});

// ============================================================================
// Tests — Atomicity (all-or-nothing)
// ============================================================================

describe('applyRatifiedOps — atomicity', () => {
  beforeEach(() => {
    mockDocs.clear();
  });

  it('throws RatificationApplyError on missing task (no partial apply)', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([
      { op: 'update_task_goal', taskId: 'nonexistent', newGoal: 'Nope' },
    ]);

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow(RatificationApplyError);

    // Workflow should NOT have been written (atomicity)
    const stored = JSON.parse(mockDocs.get('/workflows/test-skill/workflow.json')!);
    expect(stored.revision).toBe(3); // unchanged
  });

  it('aborts entire batch if any op fails', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([
      { op: 'update_task_goal', taskId: 'task-a', newGoal: 'This would succeed' },
      { op: 'update_task_goal', taskId: 'nonexistent', newGoal: 'This fails' },
    ]);

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow(RatificationApplyError);

    // First op's mutation should NOT be persisted
    const stored = JSON.parse(mockDocs.get('/workflows/test-skill/workflow.json')!);
    expect(stored.tasks[0].goal).toBe('Do task A'); // unchanged
    expect(stored.revision).toBe(3); // unchanged
  });

  it('add_task rejects duplicate taskId', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange([
      {
        op: 'add_task',
        task: {
          taskId: 'task-a',
          name: 'Task A duplicate',
          goal: 'Duplicate!',
          type: 'agent' as const,
          dependsOn: ['task-b'],
        },
      },
    ]);

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow(/already exists/);
  });
});

// ============================================================================
// Tests — Eval suite mutations
// ============================================================================

describe('applyRatifiedOps — eval suite mutations', () => {
  beforeEach(() => {
    mockDocs.clear();
  });

  it('eval.criterion.add adds a criterion to goalCriteria', async () => {
    const suite = makeEvalSuite();
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));

    const sc = makeStagedChange(
      [
        {
          op: 'eval.criterion.add',
          skillSlug: 'test-skill',
          criterion: {
            type: 'threshold',
            name: 'new-metric',
            metric: 'recall',
            operator: 'gte',
            target: 0.5,
          },
          rationale: 'Need to track recall',
        },
      ],
      { kind: 'eval_criterion_change' },
    );

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    expect(result.appliedOps).toContain('eval.criterion.add');
    const updated = JSON.parse(mockDocs.get('/evals/test-skill/suite.json')!);
    expect(updated.goalCriteria).toHaveLength(3);
    expect(updated.goalCriteria[2].name).toBe('new-metric');
  });

  it('eval.criterion.add supports targetScope=trajectory', async () => {
    const suite = makeEvalSuite();
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));

    const sc = makeStagedChange(
      [
        {
          op: 'eval.criterion.add',
          skillSlug: 'test-skill',
          targetScope: 'trajectory',
          criterion: {
            type: 'threshold',
            name: 'trajectory-quality',
            metric: 'trajectory_quality',
            operator: 'gte',
            target: 0.6,
          },
          rationale: 'Track trajectory quality',
        },
      ],
      { kind: 'eval_criterion_change' },
    );

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    const updated = JSON.parse(mockDocs.get('/evals/test-skill/suite.json')!);
    expect(updated.trajectoryCriteria).toHaveLength(1);
    expect(updated.trajectoryCriteria[0].name).toBe('trajectory-quality');
  });

  it('eval.criterion.add supports targetScope=task', async () => {
    const suite = makeEvalSuite();
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(makeWorkflow()));

    const sc = makeStagedChange(
      [
        {
          op: 'eval.criterion.add',
          skillSlug: 'test-skill',
          targetScope: 'task',
          taskId: 'task-a',
          criterion: {
            type: 'threshold',
            name: 'task-a-accuracy',
            metric: 'accuracy',
            operator: 'gte',
            target: 0.75,
          },
          rationale: 'Task-scoped quality check',
        },
      ],
      { kind: 'eval_criterion_change' },
    );

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    const updated = JSON.parse(mockDocs.get('/evals/test-skill/suite.json')!);
    expect(updated.taskCriteria['task-a']).toHaveLength(1);
    expect(updated.taskCriteria['task-a'][0].name).toBe('task-a-accuracy');
  });

  it('eval.criterion.add task scope requires taskId at apply time', async () => {
    const suite = makeEvalSuite();
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(makeWorkflow()));

    const sc = makeStagedChange(
      [
        {
          op: 'eval.criterion.add',
          skillSlug: 'test-skill',
          targetScope: 'task',
          criterion: {
            type: 'threshold',
            name: 'task-accuracy',
            metric: 'accuracy',
            operator: 'gte',
            target: 0.75,
          },
          rationale: 'Invalid because taskId is missing',
        },
      ],
      { kind: 'eval_criterion_change' },
    );

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow(/taskId is required/);
  });

  it('eval.criterion.add task scope rejects unknown workflow taskId', async () => {
    const suite = makeEvalSuite();
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(makeWorkflow()));

    const sc = makeStagedChange(
      [
        {
          op: 'eval.criterion.add',
          skillSlug: 'test-skill',
          targetScope: 'task',
          taskId: 'missing-task',
          criterion: {
            type: 'threshold',
            name: 'missing-task-accuracy',
            metric: 'accuracy',
            operator: 'gte',
            target: 0.75,
          },
          rationale: 'Should reject unknown task IDs',
        },
      ],
      { kind: 'eval_criterion_change' },
    );

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow(/unknown taskId 'missing-task'/);
  });

  it('a legacy persisted suite carrying the deleted version field still loads + applies (Plan 183c)', async () => {
    // The dead `version` field was deleted from the schema (enact-or-delete).
    // Persisted suites that still carry it must keep parsing (unknown key
    // stripped), and the rewritten doc drops it.
    const suite = makeEvalSuite();
    const legacySuite = { ...suite, version: 99 };
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(legacySuite));

    const sc = makeStagedChange(
      [
        {
          op: 'eval.criterion.remove',
          skillSlug: 'test-skill',
          criterionId: 'latency-check',
          rationale: 'Cleanup',
        },
      ],
      { kind: 'eval_criterion_change' },
    );

    const result = await applyRatifiedOps(ctx, sc);
    expect(result.applied).toBe(true);

    const updated = JSON.parse(mockDocs.get('/evals/test-skill/suite.json')!);
    expect(updated.version).toBeUndefined();
  });

  it('eval.criterion.add with replacedCriterionId atomically replaces', async () => {
    const suite = makeEvalSuite();
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));

    const sc = makeStagedChange(
      [
        {
          op: 'eval.criterion.add',
          skillSlug: 'test-skill',
          criterion: {
            type: 'threshold',
            name: 'better-accuracy',
            metric: 'accuracy',
            operator: 'gte',
            target: 0.9,
          },
          rationale: 'Replacing old accuracy check with stricter one',
          replacedCriterionId: 'accuracy-check',
        },
      ],
      { kind: 'eval_criterion_change' },
    );

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    const updated = JSON.parse(mockDocs.get('/evals/test-skill/suite.json')!);
    // Original had 2 criteria, removed one and added one = still 2
    expect(updated.goalCriteria).toHaveLength(2);
    const oldCriterion = updated.goalCriteria.find(
      (c: { name: string }) => c.name === 'accuracy-check',
    );
    expect(oldCriterion).toBeUndefined();
    const newCriterion = updated.goalCriteria.find(
      (c: { name: string }) => c.name === 'better-accuracy',
    );
    expect(newCriterion).toBeDefined();
    expect(newCriterion.target).toBe(0.9);
  });

  it('eval.criterion.add with missing replacedCriterionId throws', async () => {
    const suite = makeEvalSuite();
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));

    const sc = makeStagedChange(
      [
        {
          op: 'eval.criterion.add',
          skillSlug: 'test-skill',
          criterion: {
            type: 'threshold',
            name: 'new-one',
            metric: 'x',
            operator: 'gte',
            target: 0.5,
          },
          rationale: 'Replace nonexistent',
          replacedCriterionId: 'does-not-exist',
        },
      ],
      { kind: 'eval_criterion_change' },
    );

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow(/not found/);
  });

  it('eval.criterion.remove removes by name', async () => {
    const suite = makeEvalSuite();
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));

    const sc = makeStagedChange(
      [
        {
          op: 'eval.criterion.remove',
          skillSlug: 'test-skill',
          criterionId: 'latency-check',
          rationale: 'Latency is no longer relevant',
        },
      ],
      { kind: 'eval_criterion_change' },
    );

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    const updated = JSON.parse(mockDocs.get('/evals/test-skill/suite.json')!);
    expect(updated.goalCriteria).toHaveLength(1);
    expect(updated.goalCriteria[0].name).toBe('accuracy-check');
  });

  it('eval.criterion.remove throws on missing criterion', async () => {
    const suite = makeEvalSuite();
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));

    const sc = makeStagedChange(
      [
        {
          op: 'eval.criterion.remove',
          skillSlug: 'test-skill',
          criterionId: 'nonexistent',
          rationale: 'Ghost',
        },
      ],
      { kind: 'eval_criterion_change' },
    );

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow(/not found/);
  });

  it('eval.criterion.update merges patch into existing criterion', async () => {
    const suite = makeEvalSuite();
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));

    const sc = makeStagedChange(
      [
        {
          op: 'eval.criterion.update',
          skillSlug: 'test-skill',
          criterionId: 'accuracy-check',
          patch: { target: 0.85 },
          rationale: 'Raising accuracy bar',
        },
      ],
      { kind: 'eval_criterion_change' },
    );

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    const updated = JSON.parse(mockDocs.get('/evals/test-skill/suite.json')!);
    const criterion = updated.goalCriteria.find(
      (c: { name: string }) => c.name === 'accuracy-check',
    );
    expect(criterion.target).toBe(0.85);
  });

  it('eval suite updatedAt is bumped on mutation', async () => {
    const suite = makeEvalSuite();
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));

    const sc = makeStagedChange(
      [
        {
          op: 'eval.criterion.remove',
          skillSlug: 'test-skill',
          criterionId: 'latency-check',
          rationale: 'Cleanup',
        },
      ],
      { kind: 'eval_criterion_change' },
    );

    await applyRatifiedOps(ctx, sc);

    const updated = JSON.parse(mockDocs.get('/evals/test-skill/suite.json')!);
    expect(updated.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects duplicate criterion names after apply', async () => {
    const suite = makeEvalSuite();
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));

    // Try to add a criterion with the same name as an existing one
    const sc = makeStagedChange(
      [
        {
          op: 'eval.criterion.add',
          skillSlug: 'test-skill',
          criterion: {
            type: 'threshold',
            name: 'accuracy-check', // duplicate!
            metric: 'other',
            operator: 'gte',
            target: 0.5,
          },
          rationale: 'This collides',
        },
      ],
      { kind: 'eval_criterion_change' },
    );

    await expect(applyRatifiedOps(ctx, sc)).rejects.toThrow(/Duplicate criterion names/);
  });
});

// ============================================================================
// Tests — Mixed ops
// ============================================================================

describe('applyRatifiedOps — mixed ops', () => {
  beforeEach(() => {
    mockDocs.clear();
  });

  it('applies workflow and eval ops from the same proposal', async () => {
    const wf = makeWorkflow();
    const suite = makeEvalSuite();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));

    const sc = makeStagedChange([
      { op: 'update_task_goal', taskId: 'task-a', newGoal: 'Better goal' },
      {
        op: 'eval.criterion.add',
        skillSlug: 'test-skill',
        criterion: {
          type: 'threshold',
          name: 'new-check',
          metric: 'f1',
          operator: 'gte',
          target: 0.6,
        },
        rationale: 'Adding F1 check',
      },
    ]);

    const result = await applyRatifiedOps(ctx, sc);

    expect(result.applied).toBe(true);
    expect(result.appliedOps).toHaveLength(2);
    expect(result.newRevision).toBe(4);

    const updatedWf = JSON.parse(mockDocs.get('/workflows/test-skill/workflow.json')!);
    expect(updatedWf.tasks[0].goal).toBe('Better goal');

    const updatedSuite = JSON.parse(mockDocs.get('/evals/test-skill/suite.json')!);
    expect(updatedSuite.goalCriteria).toHaveLength(3);
  });
});

// =====================================================================

describe('applyRatifiedOps — Plan 141 stale flow', () => {
  beforeEach(() => {
    mockDocs.clear();
  });

  it('returns stale result (no mutation) when a sibling already changed the same task goal', async () => {
    // Seed the workflow at r3.
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    // Author proposal B against r3 — preconditions captured from the
    // current workflow inside makeStagedChange.
    const scB = makeStagedChange([
      { op: 'update_task_goal', taskId: 'task-a', newGoal: 'B wants this goal' },
    ]);
    // Sanity-check: B's precondition is the r3 hash of task-a.goal.
    expect(scB.preconditions).toBeDefined();
    expect(scB.preconditions![0]!.descriptor).toMatchObject({
      kind: 'task.goal',
      taskId: 'task-a',
    });

    // Simulate sibling proposal A having ratified first — task-a.goal moved.
    const wfAfterA = makeWorkflow();
    wfAfterA.tasks[0]!.goal = 'A already changed this';
    wfAfterA.revision = 4;
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wfAfterA));

    // Now apply B. It must NOT mutate the workflow.
    const result = await applyRatifiedOps(ctx, scB);

    expect(result.applied).toBe(false);
    expect(result.stale).toBeDefined();
    expect(result.stale!.conflicts).toHaveLength(1);
    expect(result.stale!.conflicts[0]!.opKind).toBe('update_task_goal');
    expect(result.stale!.conflicts[0]!.descriptor).toMatchObject({
      kind: 'task.goal',
      taskId: 'task-a',
    });

    // Workflow unchanged — still at A's r4 state, not B's.
    const stored = JSON.parse(mockDocs.get('/workflows/test-skill/workflow.json')!);
    expect(stored.revision).toBe(4);
    expect(stored.tasks[0].goal).toBe('A already changed this');
  });

  it('proposals on disjoint task fields ratify cleanly back-to-back', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    // Proposal A: edit task-a.goal. Proposal B: edit task-b.goal. Disjoint.
    const scA = makeStagedChange([{ op: 'update_task_goal', taskId: 'task-a', newGoal: 'A-goal' }]);
    const scB = makeStagedChange(
      [{ op: 'update_task_goal', taskId: 'task-b', newGoal: 'B-goal' }],
      { id: '00000000-0000-0000-0000-0000000000ff' },
    );

    const resA = await applyRatifiedOps(ctx, scA);
    expect(resA.applied).toBe(true);
    expect(resA.stale).toBeUndefined();

    // B was authored against r3; now workflow is r4. Disjoint subtree must
    // not be flagged stale — this is the entire point of per-field pinning.
    const resB = await applyRatifiedOps(ctx, scB);
    expect(resB.applied).toBe(true);
    expect(resB.stale).toBeUndefined();

    const final = JSON.parse(mockDocs.get('/workflows/test-skill/workflow.json')!);
    expect(final.tasks[0].goal).toBe('A-goal');
    expect(final.tasks[1].goal).toBe('B-goal');
    expect(final.revision).toBe(5);
  });

  it('legacy proposal (no preconditions) is refused with precondition_missing reason', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));

    const sc = makeStagedChange(
      [{ op: 'update_task_goal', taskId: 'task-a', newGoal: 'legacy attempt' }],
      { __skipPreconditions: true },
    );
    // Confirm the fixture really skipped pin computation.
    expect(sc.preconditions).toBeUndefined();

    await expect(applyRatifiedOps(ctx, sc)).rejects.toMatchObject({
      name: 'RatificationApplyError',
      reason: 'precondition_missing',
    });

    // Workflow not mutated.
    const stored = JSON.parse(mockDocs.get('/workflows/test-skill/workflow.json')!);
    expect(stored.revision).toBe(3);
    expect(stored.tasks[0].goal).toBe('Do task A');
  });

  it('eval criterion stale: update on same criterion goes stale after a sibling mutated it', async () => {
    const wf = makeWorkflow();
    mockDocs.set('/workflows/test-skill/workflow.json', JSON.stringify(wf));
    const suite = makeEvalSuite();
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suite));

    // Author proposal targeting an existing criterion ('accuracy-check'
    // matches the fixture's goalCriteria — see makeEvalSuite).
    const scB = makeStagedChange(
      [
        {
          op: 'eval.criterion.update',
          skillSlug: 'test-skill',
          criterionId: 'accuracy-check',
          patch: { target: 0.6 },
        },
      ],
      { kind: 'eval_criterion_change' },
    );
    expect(scB.preconditions![0]!.descriptor).toMatchObject({
      kind: 'eval.criterion.byName',
      name: 'accuracy-check',
    });

    // Sibling A already changed accuracy-check.target in the meantime.
    const suiteAfterA = makeEvalSuite();
    const accIndex = suiteAfterA.goalCriteria.findIndex(
      (c: { name: string }) => c.name === 'accuracy-check',
    );
    if (accIndex >= 0) {
      (suiteAfterA.goalCriteria[accIndex] as { target: number }).target = 0.99;
    }
    mockDocs.set('/evals/test-skill/suite.json', JSON.stringify(suiteAfterA));

    const result = await applyRatifiedOps(ctx, scB);
    expect(result.applied).toBe(false);
    expect(result.stale!.conflicts).toHaveLength(1);
    expect(result.stale!.conflicts[0]!.opKind).toBe('eval.criterion.update');

    // Suite content unchanged — still at A's mutation, not B's.
    const stored = JSON.parse(mockDocs.get('/evals/test-skill/suite.json')!);
    const crit = stored.goalCriteria.find(
      (c: { name: string; target: number }) => c.name === 'accuracy-check',
    );
    expect(crit.target).toBe(0.99);
  });
});

// =====================================================================
