import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  hashCanonical,
  computeOpTargetDescriptor,
  readTargetHash,
  computeProposalPreconditions,
  evaluateProposalPreconditions,
  isInScopeForPinning,
} from './preconditions.js';
import type {
  CyberneticEvalSuite,
  SkillManifest,
  StagedChange,
  StagedChangeOp,
  Workflow,
  WorkflowTask,
} from '@aflow/schemas';
import { StagedChangeSchema, TARGET_HASH_PRESENT_SENTINEL } from '@aflow/schemas';

// ============================================================================
// Fixtures
// ============================================================================

function task(taskId: string, opts?: Partial<WorkflowTask>): WorkflowTask {
  return {
    taskId,
    name: `Task ${taskId}`,
    goal: `Goal for ${taskId}`,
    ...(opts as object),
  };
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    slug: 'wf',
    name: 'Test Workflow',
    revision: 3,
    status: 'approved',
    tasks: [
      task('a', { goal: 'goal-a', context: { mode: 'inherit' } as never }),
      task('b', { goal: 'goal-b', dependsOn: ['a'] }),
      task('c', { goal: 'goal-c', dependsOn: ['b'] }),
    ],
    outcomes: [
      {
        id: 'out1',
        name: 'Outcome 1',
        evaluator: { type: 'threshold', target: 0.8 },
      } as never,
    ],
    activation: { triggerPatterns: ['pat1'], activationHint: 'hint-v1' } as never,
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
    updatedAt: '2026-05-13T00:00:00.000Z',
    goalCriteria: [
      { name: 'goal-crit-1', description: 'g1', weight: 1 } as never,
      { name: 'goal-crit-2', description: 'g2', weight: 1 } as never,
    ],
    trajectoryCriteria: [{ name: 'traj-crit-1', description: 't1', weight: 1 } as never],
    taskCriteria: { a: [{ name: 'task-crit-a-1', description: 'ta1', weight: 1 } as never] },
    ...overrides,
  } as CyberneticEvalSuite;
}

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    schemaVersion: 2,
    skillId: 'wf',
    name: 'Test skill',
    goal: { type: 'subjective', rubric: ['Output is clear'] },
    campaign: {
      fields: {
        competitionSlug: {
          schema: { type: 'string', minLength: 1 },
          identity: true,
          label: 'Competition slug',
        },
        targetScore: { schema: { type: 'number' }, label: 'Target score' },
      },
    },
    origin: 'operator',
    workflowSlug: 'wf',
    requiredCapabilities: [],
    createdAt: '2026-05-13T00:00:00.000Z',
    updatedAt: '2026-05-13T00:00:00.000Z',
    ...overrides,
  } as SkillManifest;
}

// ============================================================================
// canonicalize + hashCanonical
// ============================================================================

describe('canonicalize', () => {
  it('produces identical output regardless of key order', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
  it('handles nested objects recursively', () => {
    expect(canonicalize({ x: { c: 3, a: 1, b: 2 } })).toBe(
      canonicalize({ x: { a: 1, b: 2, c: 3 } }),
    );
  });
  it('handles arrays positionally (order matters)', () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });
  it('treats undefined values as absent', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
});

describe('hashCanonical', () => {
  it('returns a 64-char hex SHA-256', () => {
    expect(hashCanonical({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is order-stable', () => {
    expect(hashCanonical({ a: 1, b: 2 })).toBe(hashCanonical({ b: 2, a: 1 }));
  });
  it('differs when content differs', () => {
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }));
  });
});

// ============================================================================
// computeOpTargetDescriptor — exhaustive op coverage
// ============================================================================

describe('computeOpTargetDescriptor', () => {
  it('maps update_task_goal to task.goal', () => {
    const op = { op: 'update_task_goal', taskId: 'a', newGoal: 'x' } as StagedChangeOp;
    expect(computeOpTargetDescriptor(op)).toEqual({ kind: 'task.goal', taskId: 'a' });
  });
  it('maps update_task_context_spec to task.context', () => {
    const op = { op: 'update_task_context_spec', taskId: 'a', contextSpec: {} } as StagedChangeOp;
    expect(computeOpTargetDescriptor(op)).toEqual({ kind: 'task.context', taskId: 'a' });
  });
  it('maps update_task_dependencies to task.dependencies', () => {
    const op = { op: 'update_task_dependencies', taskId: 'b', dependsOn: [] } as StagedChangeOp;
    expect(computeOpTargetDescriptor(op)).toEqual({ kind: 'task.dependencies', taskId: 'b' });
  });
  it('maps promote_context_strategy to task.context (collides with update_task_context_spec)', () => {
    const op = { op: 'promote_context_strategy', taskId: 'a', newSpec: {} } as StagedChangeOp;
    expect(computeOpTargetDescriptor(op)).toEqual({ kind: 'task.context', taskId: 'a' });
  });
  it('maps add_task to task.absent', () => {
    const op = { op: 'add_task', task: { taskId: 'new' } } as StagedChangeOp;
    expect(computeOpTargetDescriptor(op)).toEqual({ kind: 'task.absent', taskId: 'new' });
  });
  it('maps remove_task to task.whole', () => {
    const op = { op: 'remove_task', taskId: 'a' } as StagedChangeOp;
    expect(computeOpTargetDescriptor(op)).toEqual({ kind: 'task.whole', taskId: 'a' });
  });
  it('maps reorder_tasks to tasks.order', () => {
    const op = { op: 'reorder_tasks', taskIds: ['a', 'b'] } as StagedChangeOp;
    expect(computeOpTargetDescriptor(op)).toEqual({ kind: 'tasks.order' });
  });
  it('maps update_outcome_threshold to outcome.threshold', () => {
    const op = {
      op: 'update_outcome_threshold',
      outcomeId: 'out1',
      newTarget: 0.9,
    } as StagedChangeOp;
    expect(computeOpTargetDescriptor(op)).toEqual({
      kind: 'outcome.threshold',
      outcomeId: 'out1',
    });
  });
  it('maps update_activation_hint to activation.hint', () => {
    const op = { op: 'update_activation_hint', newHint: 'x' } as StagedChangeOp;
    expect(computeOpTargetDescriptor(op)).toEqual({ kind: 'activation.hint' });
  });
  it('maps add_trigger_pattern to activation.trigger.absent', () => {
    const op = { op: 'add_trigger_pattern', pattern: 'pat-new' } as StagedChangeOp;
    expect(computeOpTargetDescriptor(op)).toEqual({
      kind: 'activation.trigger.absent',
      pattern: 'pat-new',
    });
  });
  it('maps eval.criterion.add to eval.criterion.absent', () => {
    const op = {
      op: 'eval.criterion.add',
      skillSlug: 'wf',
      criterion: { name: 'new-crit' },
      targetScope: 'goal',
    } as StagedChangeOp;
    expect(computeOpTargetDescriptor(op)).toMatchObject({
      kind: 'eval.criterion.absent',
      skillSlug: 'wf',
      name: 'new-crit',
      scope: 'goal',
    });
  });
  it('maps eval.criterion.update to eval.criterion.byName using criterionId', () => {
    const op = {
      op: 'eval.criterion.update',
      skillSlug: 'wf',
      criterionId: 'goal-crit-1',
      patch: {},
    } as StagedChangeOp;
    expect(computeOpTargetDescriptor(op)).toEqual({
      kind: 'eval.criterion.byName',
      skillSlug: 'wf',
      name: 'goal-crit-1',
    });
  });
  it('returns none for informational / out-of-scope ops', () => {
    const opKinds: StagedChangeOp['op'][] = [
      'flag_pattern',
      'platform_issue',
      'amend_directives',
      'skill_compose',
      'capability.definition.upsert',
      'capability.binding.remove',
    ];
    for (const opKind of opKinds) {
      const op = { op: opKind } as StagedChangeOp;
      expect(computeOpTargetDescriptor(op).kind).toBe('none');
    }
  });

  it('maps manifest ops to manifest descriptors', () => {
    expect(computeOpTargetDescriptor({ op: 'update_goal' } as StagedChangeOp)).toEqual({
      kind: 'manifest.goal',
    });
    expect(
      computeOpTargetDescriptor({ op: 'campaign.field.add', fieldKey: 'x' } as StagedChangeOp),
    ).toEqual({ kind: 'manifest.campaign.field.absent', fieldKey: 'x' });
    expect(
      computeOpTargetDescriptor({ op: 'campaign.field.update', fieldKey: 'x' } as StagedChangeOp),
    ).toEqual({ kind: 'manifest.campaign.field', fieldKey: 'x' });
    expect(
      computeOpTargetDescriptor({ op: 'campaign.field.remove', fieldKey: 'x' } as StagedChangeOp),
    ).toEqual({ kind: 'manifest.campaign.field', fieldKey: 'x' });
  });
});

describe('readTargetHash — manifest descriptors', () => {
  it('hashes the manifest goal, and conflicts when the goal drifts', () => {
    const m = makeManifest();
    const pinned = readTargetHash({ kind: 'manifest.goal' }, { manifest: m });
    expect(pinned.present).toBe(true);
    const drifted = makeManifest({ goal: { type: 'subjective', rubric: ['Different'] } });
    const now = readTargetHash({ kind: 'manifest.goal' }, { manifest: drifted });
    expect(now.hash).not.toBe(pinned.hash);
  });

  it('manifest.campaign.field hashes the field and is absent when the field is gone', () => {
    const m = makeManifest();
    const present = readTargetHash(
      { kind: 'manifest.campaign.field', fieldKey: 'targetScore' },
      { manifest: m },
    );
    expect(present.present).toBe(true);
    const removed = makeManifest({
      campaign: { fields: { competitionSlug: m.campaign!.fields['competitionSlug']! } },
    });
    const gone = readTargetHash(
      { kind: 'manifest.campaign.field', fieldKey: 'targetScore' },
      { manifest: removed },
    );
    expect(gone).toEqual({ hash: null, present: false });
  });

  it('manifest.campaign.field.absent flips to the present sentinel once the field exists', () => {
    const absent = readTargetHash(
      { kind: 'manifest.campaign.field.absent', fieldKey: 'newField' },
      { manifest: makeManifest() },
    );
    expect(absent).toEqual({ hash: null, present: true });
    const withField = makeManifest({
      campaign: {
        fields: {
          ...makeManifest().campaign!.fields,
          newField: { schema: { type: 'string' }, label: 'New' },
        },
      },
    });
    const present = readTargetHash(
      { kind: 'manifest.campaign.field.absent', fieldKey: 'newField' },
      { manifest: withField },
    );
    expect(present).toEqual({ hash: TARGET_HASH_PRESENT_SENTINEL, present: true });
  });

  it('returns present:false for manifest descriptors when no manifest is supplied', () => {
    expect(readTargetHash({ kind: 'manifest.goal' }, {})).toEqual({ hash: null, present: false });
  });
});

describe('manifest precondition roundtrip (compute → evaluate)', () => {
  it('fires a conflict when the contract field drifts between propose and apply', () => {
    const manifest = makeManifest();
    const staged = {
      kind: 'workflow_refinement' as const,
      targetWorkflowSlug: 'wf',
      proposal: {
        ops: [
          { op: 'campaign.field.update', fieldKey: 'targetScore', field: {}, rationale: 'x' },
        ] as unknown as StagedChange['proposal']['ops'],
      },
    };
    const preconditions = computeProposalPreconditions(staged, { manifest });
    expect(preconditions?.[0]?.descriptor.kind).toBe('manifest.campaign.field');

    // A sibling edit changed the same field's schema.
    const drifted = makeManifest({
      campaign: {
        fields: {
          ...manifest.campaign!.fields,
          targetScore: { schema: { type: 'integer' }, label: 'Target score' },
        },
      },
    });
    const conflicts = evaluateProposalPreconditions(
      { preconditions, proposal: staged.proposal },
      { manifest: drifted },
    );
    expect(conflicts?.length).toBe(1);
    expect(conflicts?.[0]?.descriptor.kind).toBe('manifest.campaign.field');
  });

  it('no conflict when the manifest is unchanged', () => {
    const manifest = makeManifest();
    const staged = {
      kind: 'workflow_refinement' as const,
      targetWorkflowSlug: 'wf',
      proposal: {
        ops: [
          { op: 'update_goal', goal: manifest.goal, rationale: 'x' },
        ] as unknown as StagedChange['proposal']['ops'],
      },
    };
    const preconditions = computeProposalPreconditions(staged, { manifest });
    const conflicts = evaluateProposalPreconditions(
      { preconditions, proposal: staged.proposal },
      { manifest },
    );
    expect(conflicts).toEqual([]);
  });
});

// ============================================================================
// readTargetHash — subtree extraction
// ============================================================================

describe('readTargetHash', () => {
  it('task.goal hashes only the goal field, not the whole task', () => {
    const wf = makeWorkflow();
    const goalOnly = readTargetHash({ kind: 'task.goal', taskId: 'a' }, { workflow: wf });
    const wf2 = makeWorkflow();
    // Mutate an unrelated field on the same task
    wf2.tasks[0]!.dependsOn = ['z'];
    const goalOnly2 = readTargetHash({ kind: 'task.goal', taskId: 'a' }, { workflow: wf2 });
    expect(goalOnly.hash).toBe(goalOnly2.hash);
  });
  it('task.context flips when context changes but task.goal does not', () => {
    const wf = makeWorkflow();
    const ctx1 = readTargetHash({ kind: 'task.context', taskId: 'a' }, { workflow: wf });
    const goal1 = readTargetHash({ kind: 'task.goal', taskId: 'a' }, { workflow: wf });
    const wf2 = makeWorkflow();
    wf2.tasks[0]!.context = { mode: 'different' } as never;
    const ctx2 = readTargetHash({ kind: 'task.context', taskId: 'a' }, { workflow: wf2 });
    const goal2 = readTargetHash({ kind: 'task.goal', taskId: 'a' }, { workflow: wf2 });
    expect(ctx1.hash).not.toBe(ctx2.hash);
    expect(goal1.hash).toBe(goal2.hash);
  });
  it('task.absent returns null hash when absent, sentinel when present', () => {
    const wf = makeWorkflow();
    const absent = readTargetHash({ kind: 'task.absent', taskId: 'unused' }, { workflow: wf });
    const present = readTargetHash({ kind: 'task.absent', taskId: 'a' }, { workflow: wf });
    expect(absent.hash).toBeNull();
    expect(present.hash).not.toBeNull();
  });
  it('tasks.order ignores task content but reflects ID order', () => {
    const wf = makeWorkflow();
    const wf2 = makeWorkflow();
    wf2.tasks[0]!.goal = 'totally different';
    const order1 = readTargetHash({ kind: 'tasks.order' }, { workflow: wf });
    const order2 = readTargetHash({ kind: 'tasks.order' }, { workflow: wf2 });
    expect(order1.hash).toBe(order2.hash);

    const wf3 = makeWorkflow();
    wf3.tasks = [wf3.tasks[2]!, wf3.tasks[0]!, wf3.tasks[1]!]; // reorder
    const order3 = readTargetHash({ kind: 'tasks.order' }, { workflow: wf3 });
    expect(order1.hash).not.toBe(order3.hash);
  });
  it('eval.criterion.byName finds criteria across all scopes', () => {
    const suite = makeEvalSuite();
    const suites = new Map([['wf', suite]]);
    const inGoal = readTargetHash(
      { kind: 'eval.criterion.byName', skillSlug: 'wf', name: 'goal-crit-1' },
      { evalSuites: suites },
    );
    const inTraj = readTargetHash(
      { kind: 'eval.criterion.byName', skillSlug: 'wf', name: 'traj-crit-1' },
      { evalSuites: suites },
    );
    const inTask = readTargetHash(
      { kind: 'eval.criterion.byName', skillSlug: 'wf', name: 'task-crit-a-1' },
      { evalSuites: suites },
    );
    const missing = readTargetHash(
      { kind: 'eval.criterion.byName', skillSlug: 'wf', name: 'ghost' },
      { evalSuites: suites },
    );
    expect(inGoal.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inTraj.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inTask.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(missing.present).toBe(false);
  });
});

// ============================================================================
// computeProposalPreconditions + evaluateProposalPreconditions
// ============================================================================

describe('proposal-level preconditions', () => {
  it('returns undefined for out-of-scope kinds', () => {
    const staged = {
      kind: 'skill_compose' as StagedChange['kind'],
      proposal: { ops: [{ op: 'skill_compose' } as StagedChangeOp] },
      targetWorkflowSlug: 'wf',
    };
    expect(computeProposalPreconditions(staged, { workflow: makeWorkflow() })).toBeUndefined();
  });
  it('computes 1 entry per op for workflow_refinement', () => {
    const staged = {
      kind: 'workflow_refinement' as StagedChange['kind'],
      proposal: {
        ops: [
          { op: 'update_task_goal', taskId: 'a', newGoal: 'new' },
          { op: 'update_task_goal', taskId: 'b', newGoal: 'new-b' },
        ] as StagedChangeOp[],
      },
      targetWorkflowSlug: 'wf',
    };
    const pins = computeProposalPreconditions(staged, { workflow: makeWorkflow() });
    expect(pins).toHaveLength(2);
    expect(pins![0]!.opIndex).toBe(0);
    expect(pins![0]!.descriptor.kind).toBe('task.goal');
    expect(pins![0]!.targetHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('disjoint task fields → no conflict after unrelated task changes', () => {
    const wfStart = makeWorkflow();
    const staged = {
      preconditions: undefined as never,
      proposal: {
        ops: [{ op: 'update_task_goal', taskId: 'a', newGoal: 'new' }] as StagedChangeOp[],
      },
    };
    const pins = computeProposalPreconditions(
      {
        kind: 'workflow_refinement',
        proposal: staged.proposal,
        targetWorkflowSlug: 'wf',
      },
      { workflow: wfStart },
    );
    const stagedFull = { preconditions: pins, proposal: staged.proposal };

    // Now a sibling ratification mutated task `b`'s goal (unrelated to op on `a`).
    const wfAfter = makeWorkflow();
    wfAfter.tasks[1]!.goal = 'sibling-edited-b';
    wfAfter.revision = 4;
    const conflicts = evaluateProposalPreconditions(stagedFull, { workflow: wfAfter });
    expect(conflicts).toEqual([]);
  });
  it('overlapping task field → conflict surfaces', () => {
    const wfStart = makeWorkflow();
    const opList: StagedChangeOp[] = [
      { op: 'update_task_goal', taskId: 'a', newGoal: 'new' } as StagedChangeOp,
    ];
    const pins = computeProposalPreconditions(
      {
        kind: 'workflow_refinement',
        proposal: { ops: opList },
        targetWorkflowSlug: 'wf',
      },
      { workflow: wfStart },
    );

    // Sibling ratification changed the same task's goal first.
    const wfAfter = makeWorkflow();
    wfAfter.tasks[0]!.goal = 'sibling-already-edited-a';
    wfAfter.revision = 4;
    const conflicts = evaluateProposalPreconditions(
      { preconditions: pins, proposal: { ops: opList } },
      { workflow: wfAfter },
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts![0]!.opKind).toBe('update_task_goal');
    expect(conflicts![0]!.descriptor.kind).toBe('task.goal');
  });
  it('add_task: conflict when task with same id now exists', () => {
    const wfStart = makeWorkflow();
    const opList: StagedChangeOp[] = [
      { op: 'add_task', task: { taskId: 'd', name: 'D', goal: 'g' } } as StagedChangeOp,
    ];
    const pins = computeProposalPreconditions(
      {
        kind: 'workflow_refinement',
        proposal: { ops: opList },
        targetWorkflowSlug: 'wf',
      },
      { workflow: wfStart },
    );
    expect(pins![0]!.targetHash).toBeNull(); // absent at proposal time

    const wfAfter = makeWorkflow();
    wfAfter.tasks.push({ taskId: 'd', name: 'D', goal: 'g' } as never);
    const conflicts = evaluateProposalPreconditions(
      { preconditions: pins, proposal: { ops: opList } },
      { workflow: wfAfter },
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts![0]!.descriptor.kind).toBe('task.absent');
  });
  it('remove_task: conflict when target task no longer matches', () => {
    const wfStart = makeWorkflow();
    const opList: StagedChangeOp[] = [{ op: 'remove_task', taskId: 'a' } as StagedChangeOp];
    const pins = computeProposalPreconditions(
      {
        kind: 'workflow_refinement',
        proposal: { ops: opList },
        targetWorkflowSlug: 'wf',
      },
      { workflow: wfStart },
    );

    // Sibling modified `a` between authoring and ratify
    const wfAfter = makeWorkflow();
    wfAfter.tasks[0]!.goal = 'sibling-edited';
    const conflicts = evaluateProposalPreconditions(
      { preconditions: pins, proposal: { ops: opList } },
      { workflow: wfAfter },
    );
    expect(conflicts).toHaveLength(1);
  });
  it('eval.criterion.add: conflict when name became present', () => {
    const suite = makeEvalSuite();
    const opList: StagedChangeOp[] = [
      {
        op: 'eval.criterion.add',
        skillSlug: 'wf',
        criterion: { name: 'new-goal-crit' },
        targetScope: 'goal',
      } as StagedChangeOp,
    ];
    const pins = computeProposalPreconditions(
      {
        kind: 'eval_criterion_change',
        proposal: { ops: opList },
        targetWorkflowSlug: 'wf',
      },
      { evalSuites: new Map([['wf', suite]]) },
    );
    expect(pins![0]!.targetHash).toBeNull();

    const suiteAfter = makeEvalSuite();
    suiteAfter.goalCriteria.push({ name: 'new-goal-crit', description: '', weight: 1 } as never);
    const conflicts = evaluateProposalPreconditions(
      { preconditions: pins, proposal: { ops: opList } },
      { evalSuites: new Map([['wf', suiteAfter]]) },
    );
    expect(conflicts).toHaveLength(1);
  });
  it('returns null when preconditions are missing (legacy proposal)', () => {
    const staged = {
      preconditions: undefined,
      proposal: {
        ops: [{ op: 'update_task_goal', taskId: 'a', newGoal: 'x' }] as StagedChangeOp[],
      },
    };
    const conflicts = evaluateProposalPreconditions(staged, { workflow: makeWorkflow() });
    expect(conflicts).toBeNull();
  });
});

describe('isInScopeForPinning', () => {
  it('returns true for workflow_refinement and eval_criterion_change', () => {
    expect(isInScopeForPinning('workflow_refinement')).toBe(true);
    expect(isInScopeForPinning('eval_criterion_change')).toBe(true);
  });
  it('returns false for everything else', () => {
    expect(isInScopeForPinning('skill_compose')).toBe(false);
    expect(isInScopeForPinning('capability_binding')).toBe(false);
    expect(isInScopeForPinning('pattern_flag')).toBe(false);
    expect(isInScopeForPinning('directive_amendment')).toBe(false);
    expect(isInScopeForPinning('platform_issue')).toBe(false);
  });
});

// ============================================================================
// Schema/runtime contract — born-stale proposals must round-trip
// ============================================================================
//
// Regression for the silent-drop bug where a Coach proposal whose ops
// included an absent-target descriptor (`task.absent`,
// `activation.trigger.absent`, `eval.criterion.absent`) with the target
// CURRENTLY PRESENT would persist `targetHash: '__present__'` — a value the
// schema's old hex-only regex rejected. `StagedChangeSchema.parse()` then
// threw, and every reader (`coachProposalSource`, `proposal.list`,
// `loadProposal`) caught + silently skipped the doc. Result: proposals
// existed in the DB but Action Center, Helmsman, and the REST routes all
// reported "none". See `TARGET_HASH_PRESENT_SENTINEL` in
// `packages/schemas/src/cybernetic/stagedChange.ts`.
// ============================================================================

describe('schema/runtime contract for born-stale preconditions', () => {
  it('round-trips a born-stale add_task through StagedChangeSchema (sentinel allowed)', () => {
    // The bug shape: Coach proposes `add_task({taskId: 'a'})` but task 'a'
    // already exists in the target workflow at proposal-creation time.
    // `readTargetHash({kind:'task.absent', taskId:'a'}, wf)` returns the
    // sentinel, which gets persisted into the proposal's preconditions[].
    const wf = makeWorkflow(); // contains tasks 'a','b','c'
    const opList: StagedChangeOp[] = [
      {
        op: 'add_task',
        task: {
          taskId: 'a',
          name: 'A',
          goal: 'g',
          type: 'human',
          pauseInstruction: 'Operator must confirm step.',
        },
      } as StagedChangeOp,
    ];
    const pins = computeProposalPreconditions(
      {
        kind: 'workflow_refinement',
        proposal: { ops: opList },
        targetWorkflowSlug: 'wf',
      },
      { workflow: wf },
    );

    expect(pins).toBeDefined();
    expect(pins![0]!.targetHash).toBe(TARGET_HASH_PRESENT_SENTINEL);

    // Spot-check the constant the runtime imports matches the literal value
    // historical proposals on disk carry.
    expect(TARGET_HASH_PRESENT_SENTINEL).toBe('__present__');

    const staged = {
      id: '00000000-0000-0000-0000-000000000001',
      kind: 'workflow_refinement' as const,
      status: 'proposed' as const,
      source: 'coach' as const,
      authorityLevel: 'stage_for_review' as const,
      resolutionRoute: 'tenant_ratification' as const,
      rebaseState: 'clean' as const,
      coachSessionId: '00000000-0000-0000-0000-000000000002',
      targetWorkflowSlug: 'wf',
      pinnedRevision: 3,
      preconditions: pins,
      proposal: {
        summary: 'add task a (born-stale)',
        rationale: 'r',
        confidence: 'low' as const,
        ops: opList,
      },
      evidence: {
        sourceSessionIds: ['00000000-0000-0000-0000-000000000003'],
      },
      proposedAt: '2026-05-25T09:16:30.269Z',
      expiresAt: '2026-06-25T09:16:30.269Z',
    };

    const result = StagedChangeSchema.safeParse(staged);
    // Pre-fix this was `success: false` with a regex error on
    // `preconditions.0.targetHash`. The whole point of the fix is to make
    // this assert pass — pin it so the schema can't tighten back into the
    // silent-drop shape without a test red-flagging it.
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preconditions?.[0]?.targetHash).toBe(TARGET_HASH_PRESENT_SENTINEL);
    }
  });
});
