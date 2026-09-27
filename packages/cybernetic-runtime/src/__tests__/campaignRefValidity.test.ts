import { describe, it, expect } from 'vitest';
import type {
  CyberneticEvalSuite,
  EvalCriterion,
  Outcome,
  SkillCampaignContract,
  SkillGoal,
  StagedChangeOp,
  Workflow,
  WorkflowTask,
} from '@aflow/schemas';
import { materializeAndValidateSkillConfig } from '../skillValidity/skillValidity.js';
import type { SkillCampaignChecks } from '../skillValidity/skillValidity.js';
import { applyOpsToSnapshot } from '../stagedChange/applyOpsToSnapshot.js';
import { runWorkflowProposalValidations } from '../stagedChange/proposalValidations.js';

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

function validate(campaign: SkillCampaignChecks) {
  return materializeAndValidateSkillConfig({
    tasks: [agent('do-thing')],
    campaign,
  }).validity;
}

function codes(validity: { diagnostics: readonly { code: string }[] }): string[] {
  return validity.diagnostics.map((d) => d.code);
}

describe('campaign_ref_unknown_field', () => {
  it('fires when a ref names an undeclared field', () => {
    const validity = validate({
      contract: CONTRACT,
      goal: {
        type: 'numeric',
        metricKey: 'lbValue',
        direction: { $campaign: 'noSuchField' },
      },
    });
    expect(validity.status).toBe('invalid');
    const diag = validity.diagnostics.find((d) => d.code === 'campaign_ref_unknown_field');
    expect(diag?.field).toBe('noSuchField');
    expect(diag?.dimension).toBe('ref');
  });

  it('fires when refs exist but NO contract is declared at all', () => {
    const validity = validate({ goal: PARAM_GOAL });
    expect(codes(validity)).toContain('campaign_ref_unknown_field');
    expect(
      validity.diagnostics.find((d) => d.code === 'campaign_ref_unknown_field')?.detail,
    ).toContain('no campaign contract');
  });

  it('does not fire for refs to declared fields', () => {
    const validity = validate({ contract: CONTRACT, goal: PARAM_GOAL, outcomes: [PARAM_OUTCOME] });
    expect(codes(validity)).not.toContain('campaign_ref_unknown_field');
    expect(validity.status).toBe('valid');
  });
});

describe('campaign_ref_type_mismatch', () => {
  it('fires when a number slot references a non-numeric field', () => {
    const validity = validate({
      contract: CONTRACT,
      outcomes: [
        {
          id: 'o',
          name: 'o',
          evaluator: {
            type: 'threshold',
            metric: 'lbValue',
            operator: 'gte',
            target: { $campaign: 'competitionSlug' }, // string field in a number slot
          },
        },
      ],
    });
    const diag = validity.diagnostics.find((d) => d.code === 'campaign_ref_type_mismatch');
    expect(diag).toBeDefined();
    expect(diag?.field).toBe('competitionSlug');
  });

  it('fires when an enum slot value-references a field without a compatible enum', () => {
    const validity = validate({
      contract: CONTRACT,
      goal: {
        type: 'numeric',
        metricKey: 'lbValue',
        direction: { $campaign: 'competitionSlug' }, // free string, no enum
      },
    });
    expect(codes(validity)).toContain('campaign_ref_type_mismatch');
  });

  it('does not fire for a number slot referencing a numeric field', () => {
    const validity = validate({
      contract: CONTRACT,
      outcomes: [
        {
          id: 'o',
          name: 'o',
          evaluator: {
            type: 'threshold',
            metric: 'lbValue',
            operator: 'gte',
            target: { $campaign: 'targetScore' },
          },
        },
      ],
    });
    expect(codes(validity)).not.toContain('campaign_ref_type_mismatch');
  });

  it('does not fire for an enum slot value-referencing a slot-compatible enum field', () => {
    const validity = validate({ contract: CONTRACT, goal: PARAM_GOAL });
    expect(codes(validity)).not.toContain('campaign_ref_type_mismatch');
  });
});

describe('campaign_ref_map_incomplete', () => {
  const goalCriterion = (operator: unknown): EvalCriterion =>
    ({
      type: 'threshold',
      name: 'lb-target-met',
      metric: 'lbValue',
      operator,
      target: { $campaign: 'targetScore' },
    }) as EvalCriterion;

  it('fires when the map misses an enum value', () => {
    const validity = validate({
      contract: CONTRACT,
      goalCriteria: [goalCriterion({ $campaign: 'metricDirection', map: { maximize: 'gte' } })],
    });
    const diag = validity.diagnostics.find((d) => d.code === 'campaign_ref_map_incomplete');
    expect(diag).toBeDefined();
    expect(diag?.detail).toContain('minimize');
    expect(diag?.dimension).toBe('eval_linkage');
  });

  it('fires when the mapped field has no enum at all', () => {
    const validity = validate({
      contract: CONTRACT,
      goalCriteria: [goalCriterion({ $campaign: 'competitionSlug', map: { titanic: 'gte' } })],
    });
    expect(codes(validity)).toContain('campaign_ref_map_incomplete');
  });

  it('does not fire when the map covers the full enum', () => {
    const validity = validate({
      contract: CONTRACT,
      goalCriteria: [
        goalCriterion({ $campaign: 'metricDirection', map: { maximize: 'gte', minimize: 'lte' } }),
      ],
    });
    expect(codes(validity)).not.toContain('campaign_ref_map_incomplete');
  });
});

describe('placeholder_constant_in_parameterized_skill', () => {
  const LITERAL_OUTCOME: Outcome = {
    id: 'lb-target',
    name: 'Leaderboard target',
    evaluator: { type: 'threshold', metric: 'lbValue', operator: 'gt', target: 0.5 },
  };

  it('fires on a literal outcome target on the goal metric when a contract is declared', () => {
    const validity = validate({
      contract: CONTRACT,
      goal: PARAM_GOAL,
      outcomes: [LITERAL_OUTCOME],
    });
    expect(validity.status).toBe('invalid');
    expect(codes(validity)).toContain('placeholder_constant_in_parameterized_skill');
  });

  it('does NOT fire on a literal outcome on a NON-goal metric (legitimate fixed check)', () => {
    const validity = validate({
      contract: CONTRACT,
      goal: PARAM_GOAL,
      outcomes: [
        {
          id: 'error-budget',
          name: 'Error rate within budget',
          evaluator: { type: 'threshold', metric: 'errorRate', operator: 'lte', target: 0.01 },
        },
      ],
    });
    expect(codes(validity)).not.toContain('placeholder_constant_in_parameterized_skill');
  });

  it('does NOT fire on outcomes when the contracted skill has no numeric goal (no bar to protect)', () => {
    const validity = validate({ contract: CONTRACT, outcomes: [LITERAL_OUTCOME] });
    expect(codes(validity)).not.toContain('placeholder_constant_in_parameterized_skill');
  });

  it('fires on a literal goal-tier criterion target when a contract is declared', () => {
    const validity = validate({
      contract: CONTRACT,
      goalCriteria: [
        {
          type: 'threshold',
          name: 'lb-target-met',
          metric: 'lbValue',
          operator: 'gt',
          target: 0.5,
        },
      ],
    });
    expect(codes(validity)).toContain('placeholder_constant_in_parameterized_skill');
  });

  it('does NOT fire without a campaign contract (literal targets are the normal case)', () => {
    const validity = validate({ outcomes: [LITERAL_OUTCOME] });
    expect(codes(validity)).not.toContain('placeholder_constant_in_parameterized_skill');
    expect(validity.status).toBe('valid');
  });

  it('does NOT fire when the contracted skill references the bar via $campaign', () => {
    const validity = validate({ contract: CONTRACT, outcomes: [PARAM_OUTCOME] });
    expect(codes(validity)).not.toContain('placeholder_constant_in_parameterized_skill');
    expect(validity.status).toBe('valid');
  });
});

describe('campaign_input binding rules (Plan 195 §4.4)', () => {
  function taskWithCampaignBinding(path: string): WorkflowTask {
    return {
      taskId: 'consumer',
      name: 'consumer',
      goal: 'g',
      type: 'operation',
      operation: 'memory.store.get',
      inputBindings: { slot: { kind: 'campaign_input', path } },
    } as WorkflowTask;
  }

  function validateTasks(tasks: WorkflowTask[], campaign: SkillCampaignChecks) {
    return materializeAndValidateSkillConfig({ tasks, campaign }).validity;
  }

  it('campaign_input_without_contract fires when the manifest has no contract', () => {
    const validity = validateTasks([taskWithCampaignBinding('competitionSlug')], {});
    expect(codes(validity)).toContain('campaign_input_without_contract');
    expect(validity.status).toBe('invalid');
  });

  it('campaign_input_unknown_field fires when the path head is undeclared', () => {
    const validity = validateTasks([taskWithCampaignBinding('noSuchField')], {
      contract: CONTRACT,
    });
    const diag = validity.diagnostics.find((d) => d.code === 'campaign_input_unknown_field');
    expect(diag).toBeDefined();
    expect(diag?.taskId).toBe('consumer');
    expect(diag?.detail).toContain('competitionSlug');
  });

  it('does not fire for a declared field (dotted path resolves by head segment)', () => {
    const validity = validateTasks([taskWithCampaignBinding('competitionSlug')], {
      contract: CONTRACT,
    });
    expect(codes(validity)).not.toContain('campaign_input_unknown_field');
    expect(codes(validity)).not.toContain('campaign_input_without_contract');
  });

  it('does not run on a tasks-only recompute (campaign inputs out of scope)', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [taskWithCampaignBinding('competitionSlug')],
    });
    expect(codes(validity)).not.toContain('campaign_input_without_contract');
  });
});

describe('campaign checks only run when campaign inputs are supplied', () => {
  it('a tasks-only validate (read-side recompute) ignores campaign inputs', () => {
    const { validity } = materializeAndValidateSkillConfig({ tasks: [agent('t')] });
    expect(validity.status).toBe('valid');
  });
});

// ============================================================================

const CAMPAIGN_PARAMS = { contract: CONTRACT, goal: PARAM_GOAL };

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

function makeEvalSuite(overrides: Partial<CyberneticEvalSuite> = {}): CyberneticEvalSuite {
  return {
    version: 1,
    skillSlug: 'kaggle-opt',
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    createdBy: 'test',
    goalCriteria: [],
    trajectoryCriteria: [],
    taskCriteria: {},
    ...overrides,
  } as CyberneticEvalSuite;
}

describe('campaign rules at the refinement apply transform (applyOpsToSnapshot)', () => {
  it('rejects update_outcome_threshold introducing a literal target on a contracted skill', () => {
    const result = applyOpsToSnapshot({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      ops: [
        {
          op: 'update_outcome_threshold',
          outcomeId: 'lb-target',
          newTarget: 0.5,
        } as StagedChangeOp,
      ],
      targetSlug: 'kaggle-opt',
      campaign: CAMPAIGN_PARAMS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureCode).toBe(
        'graph_validator:placeholder_constant_in_parameterized_skill',
      );
      expect(result.diagnostics?.map((d) => d.code)).toContain(
        'placeholder_constant_in_parameterized_skill',
      );
    }
  });

  it('allows update_outcome_threshold when no campaign contract is in scope', () => {
    const result = applyOpsToSnapshot({
      workflow: makeWorkflow({
        outcomes: [
          {
            id: 'lb-target',
            name: 'Leaderboard target',
            evaluator: { type: 'threshold', metric: 'lbValue', operator: 'gt', target: 0.4 },
          },
        ],
      }),
      evalSuites: new Map(),
      ops: [
        {
          op: 'update_outcome_threshold',
          outcomeId: 'lb-target',
          newTarget: 0.5,
        } as StagedChangeOp,
      ],
      targetSlug: 'kaggle-opt',
    });
    expect(result.ok).toBe(true);
  });

  it('allows a campaign-coherent refinement on a contracted skill', () => {
    const result = applyOpsToSnapshot({
      workflow: makeWorkflow(),
      evalSuites: new Map(),
      ops: [{ op: 'update_task_goal', taskId: 'do-thing', newGoal: 'updated' } as StagedChangeOp],
      targetSlug: 'kaggle-opt',
      campaign: CAMPAIGN_PARAMS,
    });
    expect(result.ok).toBe(true);
  });
});

describe('campaign rules at the eval-criterion apply transform (applyOpsToSnapshot)', () => {
  const addCriterion = (criterion: Record<string, unknown>, skillSlug = 'kaggle-opt') =>
    ({
      op: 'eval.criterion.add',
      skillSlug,
      criterion,
      targetScope: 'goal',
      rationale: 'test',
    }) as StagedChangeOp;

  it('rejects a literal goal-tier threshold target on a contracted skill', () => {
    const result = applyOpsToSnapshot({
      workflow: null,
      evalSuites: new Map([['kaggle-opt', makeEvalSuite()]]),
      ops: [
        addCriterion({
          type: 'threshold',
          name: 'lb-target-met',
          metric: 'lbValue',
          operator: 'gt',
          target: 0.5,
        }),
      ],
      targetSlug: 'kaggle-opt',
      campaign: CAMPAIGN_PARAMS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureCode).toBe('campaign_ref:placeholder_constant_in_parameterized_skill');
      expect(result.diagnostics?.map((d) => d.code)).toContain(
        'placeholder_constant_in_parameterized_skill',
      );
    }
  });

  it('rejects a $campaign ref to an undeclared contract field', () => {
    const result = applyOpsToSnapshot({
      workflow: null,
      evalSuites: new Map([['kaggle-opt', makeEvalSuite()]]),
      ops: [
        addCriterion({
          type: 'threshold',
          name: 'lb-target-met',
          metric: 'lbValue',
          operator: 'gt',
          target: { $campaign: 'noSuchField' },
        }),
      ],
      targetSlug: 'kaggle-opt',
      campaign: CAMPAIGN_PARAMS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureCode).toBe('campaign_ref:campaign_ref_unknown_field');
    }
  });

  it('accepts a $campaign-parameterized goal-tier criterion on a contracted skill', () => {
    const result = applyOpsToSnapshot({
      workflow: null,
      evalSuites: new Map([['kaggle-opt', makeEvalSuite()]]),
      ops: [
        addCriterion({
          type: 'threshold',
          name: 'lb-target-met',
          metric: 'lbValue',
          operator: { $campaign: 'metricDirection', map: { maximize: 'gte', minimize: 'lte' } },
          target: { $campaign: 'targetScore' },
        }),
      ],
      targetSlug: 'kaggle-opt',
      campaign: CAMPAIGN_PARAMS,
    });
    expect(result.ok).toBe(true);
  });

  it('does not apply the target contract to a foreign-slug suite', () => {
    const result = applyOpsToSnapshot({
      workflow: null,
      evalSuites: new Map([['other-skill', makeEvalSuite({ skillSlug: 'other-skill' })]]),
      ops: [
        addCriterion(
          {
            type: 'threshold',
            name: 'lb-target-met',
            metric: 'lbValue',
            operator: 'gt',
            target: 0.5,
          },
          'other-skill',
        ),
      ],
      targetSlug: 'kaggle-opt',
      campaign: CAMPAIGN_PARAMS,
    });
    expect(result.ok).toBe(true);
  });
});

describe('eval-birth — a suite-less skill gains its first criterion', () => {
  const add = (skillSlug: string) =>
    ({
      op: 'eval.criterion.add',
      skillSlug,
      criterion: { type: 'threshold', name: 'first', metric: 'score', operator: 'gt', target: 0 },
      targetScope: 'goal',
      rationale: 'birth',
    }) as StagedChangeOp;

  it('births a suite from eval.criterion.add when none exists', () => {
    const result = applyOpsToSnapshot({
      workflow: null,
      evalSuites: new Map(),
      ops: [add('fresh-skill')],
      targetSlug: 'fresh-skill',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.candidateEvalSuites.get('fresh-skill')?.goalCriteria.map((c) => c.name),
      ).toEqual(['first']);
    }
  });

  it('still fails a remove against a missing suite (nothing to target)', () => {
    const result = applyOpsToSnapshot({
      workflow: null,
      evalSuites: new Map(),
      ops: [
        {
          op: 'eval.criterion.remove',
          skillSlug: 'fresh-skill',
          criterionId: 'nope',
          rationale: 'x',
        } as StagedChangeOp,
      ],
      targetSlug: 'fresh-skill',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failureCode).toBe('target_skill_missing');
  });
});

describe('campaign rules at the proposal-validations runner', () => {
  const LITERAL_OUTCOME_WF = makeWorkflow({
    outcomes: [
      {
        id: 'lb-target',
        name: 'Leaderboard target',
        evaluator: { type: 'threshold', metric: 'lbValue', operator: 'gt', target: 0.5 },
      },
    ],
  });
  const SNAPSHOT = { apiBindings: [], mcpBindings: [] };

  it('flags a literal outcome target as a contract blocker when campaign params are passed', () => {
    const readiness = runWorkflowProposalValidations(LITERAL_OUTCOME_WF, SNAPSHOT, CAMPAIGN_PARAMS);
    expect(readiness.contract.status).toBe('invalid');
    expect(readiness.contract.diagnostics.map((d) => d.code)).toContain(
      'placeholder_constant_in_parameterized_skill',
    );
  });

  it('does not flag the same workflow without campaign params (no contract in scope)', () => {
    const readiness = runWorkflowProposalValidations(LITERAL_OUTCOME_WF, SNAPSHOT);
    expect(readiness.contract.status).toBe('valid');
  });
});
