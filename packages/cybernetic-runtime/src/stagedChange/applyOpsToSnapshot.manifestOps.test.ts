import { describe, it, expect } from 'vitest';
import type {
  CyberneticEvalSuite,
  Outcome,
  SkillCampaignContract,
  SkillGoal,
  SkillManifest,
  StagedChangeOp,
  Workflow,
  WorkflowTask,
} from '@aflow/schemas';
import { applyOpsToSnapshot } from './applyOpsToSnapshot.js';

function agent(taskId: string): WorkflowTask {
  return { taskId, name: taskId, goal: 'g', type: 'agent' };
}

const CONTRACT: SkillCampaignContract = {
  fields: {
    competitionSlug: {
      schema: { type: 'string', minLength: 1 },
      identity: true,
      label: 'Competition slug',
    },
    metricDirection: {
      schema: { type: 'string', enum: ['maximize', 'minimize'] },
      label: 'Metric direction',
    },
    targetScore: { schema: { type: 'number' }, label: 'Target score' },
  },
};

const PARAM_GOAL: SkillGoal = {
  type: 'numeric',
  metricKey: 'lbValue',
  direction: { $campaign: 'metricDirection' },
};

const PARAM_OUTCOME: Outcome = {
  id: 'lb-target',
  name: 'Leaderboard target',
  evaluator: {
    type: 'threshold',
    metric: 'lbValue',
    operator: { $campaign: 'metricDirection', map: { maximize: 'gte', minimize: 'lte' } },
    target: { $campaign: 'targetScore' },
  },
};

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    slug: 'kaggle-opt',
    name: 'Kaggle optimizer',
    description: '',
    mode: 'process',
    revision: 3,
    status: 'approved',
    tasks: [agent('do-thing')],
    outcomes: [PARAM_OUTCOME],
    iteration: { maxConsecutiveRuns: 5 } as never,
    stateVariables: [],
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  } as Workflow;
}

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    schemaVersion: 2,
    skillId: 'kaggle-opt',
    name: 'Kaggle optimizer',
    goal: PARAM_GOAL,
    campaign: CONTRACT,
    origin: 'operator',
    workflowSlug: 'kaggle-opt',
    requiredCapabilities: [],
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  } as SkillManifest;
}

describe('applyOpsToSnapshot — manifest ops', () => {
  it('update_goal replaces the manifest goal', () => {
    const nextGoal: SkillGoal = { type: 'subjective', rubric: ['Output is well-structured'] };
    const result = applyOpsToSnapshot({
      workflow: makeWorkflow({ outcomes: [] }),
      evalSuites: new Map(),
      manifest: makeManifest({ goal: nextGoal, campaign: undefined }),
      ops: [{ op: 'update_goal', goal: nextGoal, rationale: 'test' } as StagedChangeOp],
      targetSlug: 'kaggle-opt',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifestChanged).toBe(true);
      expect(result.candidateManifest?.goal).toEqual(nextGoal);
    }
  });

  it('campaign.field.add adds a new field', () => {
    const result = applyOpsToSnapshot({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      manifest: makeManifest(),
      ops: [
        {
          op: 'campaign.field.add',
          fieldKey: 'maxRuntime',
          field: { schema: { type: 'number' }, label: 'Max runtime' },
          rationale: 'test',
        } as StagedChangeOp,
      ],
      targetSlug: 'kaggle-opt',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidateManifest?.campaign?.fields['maxRuntime']).toBeDefined();
      // The original contract must be untouched (no mutation of input).
      expect(result.candidateManifest?.campaign?.fields['competitionSlug']).toBeDefined();
    }
  });

  it('campaign.field.add rejects a duplicate key', () => {
    const result = applyOpsToSnapshot({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      manifest: makeManifest(),
      ops: [
        {
          op: 'campaign.field.add',
          fieldKey: 'competitionSlug',
          field: { schema: { type: 'string' }, label: 'dup' },
          rationale: 'test',
        } as StagedChangeOp,
      ],
      targetSlug: 'kaggle-opt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe('manifest_apply_error');
  });

  it('campaign.field.update rejects flipping the identity flag', () => {
    const result = applyOpsToSnapshot({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      manifest: makeManifest(),
      ops: [
        {
          op: 'campaign.field.update',
          fieldKey: 'competitionSlug',
          // identity omitted ⇒ false, flipping the existing identity:true field.
          field: { schema: { type: 'string', minLength: 1 }, label: 'Competition slug' },
          rationale: 'test',
        } as StagedChangeOp,
      ],
      targetSlug: 'kaggle-opt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe('manifest_apply_error');
  });

  it('campaign.field.remove rejects a missing key', () => {
    const result = applyOpsToSnapshot({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      manifest: makeManifest(),
      ops: [{ op: 'campaign.field.remove', fieldKey: 'nope', rationale: 'test' } as StagedChangeOp],
      targetSlug: 'kaggle-opt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe('manifest_apply_error');
  });

  it('removing a contract field still referenced by the workflow fails validation', () => {
    // targetScore is referenced by PARAM_OUTCOME's threshold target.
    const result = applyOpsToSnapshot({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      manifest: makeManifest(),
      ops: [
        {
          op: 'campaign.field.remove',
          fieldKey: 'targetScore',
          rationale: 'test',
        } as StagedChangeOp,
      ],
      targetSlug: 'kaggle-opt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureCode.startsWith('graph_validator')).toBe(true);
    }
  });

  it('removing a contract field still referenced by an eval criterion fails validation', () => {
    const suite: CyberneticEvalSuite = {
      version: 1,
      skillSlug: 'kaggle-opt',
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z',
      createdBy: 'test',
      goalCriteria: [
        {
          type: 'threshold',
          name: 'lb-target-met',
          metric: 'lbValue',
          operator: 'gt',
          target: { $campaign: 'targetScore' },
        },
      ],
      trajectoryCriteria: [],
      taskCriteria: {},
    } as CyberneticEvalSuite;
    const result = applyOpsToSnapshot({
      // No workflow outcomes referencing the field — the eval suite is the only
      // remaining referent, so this isolates the eval-ref re-validation path.
      workflow: makeWorkflow({ outcomes: [] }),
      evalSuites: new Map([['kaggle-opt', suite]]),
      manifest: makeManifest(),
      ops: [
        {
          op: 'campaign.field.remove',
          fieldKey: 'targetScore',
          rationale: 'test',
        } as StagedChangeOp,
      ],
      targetSlug: 'kaggle-opt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureCode.startsWith('campaign_ref')).toBe(true);
    }
  });

  it('returns target_skill_missing when manifest ops are staged but no manifest snapshot', () => {
    const result = applyOpsToSnapshot({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      manifest: null,
      ops: [
        { op: 'campaign.field.remove', fieldKey: 'targetScore', rationale: 'x' } as StagedChangeOp,
      ],
      targetSlug: 'kaggle-opt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe('target_skill_missing');
  });

  it('campaign.field.update rejects reshaping an identity field schema', () => {
    const result = applyOpsToSnapshot({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      manifest: makeManifest(),
      ops: [
        {
          op: 'campaign.field.update',
          fieldKey: 'competitionSlug',
          // identity kept true, but the schema is narrowed — a different value-domain.
          field: {
            schema: { type: 'string', enum: ['titanic'] },
            identity: true,
            label: 'Competition slug',
          },
          rationale: 'test',
        } as StagedChangeOp,
      ],
      targetSlug: 'kaggle-opt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe('manifest_apply_error');
  });

  it('campaign.field.update allows relabeling an identity field', () => {
    const result = applyOpsToSnapshot({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      manifest: makeManifest(),
      ops: [
        {
          op: 'campaign.field.update',
          fieldKey: 'competitionSlug',
          field: {
            schema: { minLength: 1, type: 'string' },
            identity: true,
            label: 'Kaggle competition',
            description: 'The competition this campaign targets',
          },
          rationale: 'test',
        } as StagedChangeOp,
      ],
      targetSlug: 'kaggle-opt',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidateManifest?.campaign?.fields['competitionSlug']?.label).toBe(
        'Kaggle competition',
      );
    }
  });

  it('derives the effective campaign from the post-edit manifest for a mixed proposal', () => {
    // Add a field AND a coherent task-goal edit in one proposal.
    const result = applyOpsToSnapshot({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      manifest: makeManifest(),
      ops: [
        {
          op: 'campaign.field.add',
          fieldKey: 'maxRuntime',
          field: { schema: { type: 'number' }, label: 'Max runtime' },
          rationale: 'test',
        } as StagedChangeOp,
        { op: 'update_task_goal', taskId: 'do-thing', newGoal: 'updated' } as StagedChangeOp,
      ],
      targetSlug: 'kaggle-opt',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifestChanged).toBe(true);
      expect(result.candidateManifest?.campaign?.fields['maxRuntime']).toBeDefined();
      expect(result.candidateWorkflow?.tasks[0]?.goal).toBe('updated');
    }
  });
});
