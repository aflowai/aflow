import { describe, it, expect } from 'vitest';
import {
  SkillGoalSchema,
  MaterializedSkillGoalSchema,
  ThresholdCriterionSchema,
  OutcomeSchema,
  resolveCampaignGoal,
  resolveEvalCriterionParams,
  resolveOutcomeEvaluatorParams,
  resolveCampaignTargetBar,
  compareWithThresholdOperator,
  criterionHasCampaignRefs,
  outcomeHasCampaignRefs,
  goalHasCampaignRefs,
  isCampaignRef,
  type Outcome,
  type SkillGoal,
  type EvalCriterion,
} from '../index.js';

const KAGGLE_CONFIG = {
  competitionSlug: 'titanic',
  metricName: 'Accuracy',
  metricDirection: 'maximize',
  targetScore: 0.8,
  dailySubmissionLimit: 10,
};

const MINIMIZE_CONFIG = {
  ...KAGGLE_CONFIG,
  competitionSlug: 'house-prices',
  metricName: 'RMSE',
  metricDirection: 'minimize',
  targetScore: 0.12,
};

// ============================================================================
// Schema unions
// ============================================================================

describe('schema unions — literal | $campaign-ref', () => {
  it('SkillGoal numeric accepts a literal direction', () => {
    const parsed = SkillGoalSchema.parse({
      type: 'numeric',
      metricKey: 'lbValue',
      direction: 'maximize',
    });
    expect(parsed).toEqual({ type: 'numeric', metricKey: 'lbValue', direction: 'maximize' });
  });

  it('SkillGoal numeric accepts a $campaign value ref for direction', () => {
    const parsed = SkillGoalSchema.parse({
      type: 'numeric',
      metricKey: 'lbValue',
      direction: { $campaign: 'metricDirection' },
    });
    expect(goalHasCampaignRefs(parsed)).toBe(true);
  });

  it('SkillGoal.threshold is DELETED (strict consumers see no threshold)', () => {
    const parsed = SkillGoalSchema.parse({
      type: 'numeric',
      metricKey: 'lbValue',
      direction: 'maximize',
      threshold: 0.8, // stripped — the field no longer exists on the schema
    });
    expect('threshold' in parsed).toBe(false);
    const materialized = MaterializedSkillGoalSchema.parse(parsed);
    expect('threshold' in materialized).toBe(false);
  });

  it('ThresholdCriterion accepts $campaign refs on operator and target', () => {
    const parsed = ThresholdCriterionSchema.parse({
      type: 'threshold',
      name: 'lb-target-met',
      metric: 'lbValue',
      operator: { $campaign: 'metricDirection', map: { maximize: 'gte', minimize: 'lte' } },
      target: { $campaign: 'targetScore' },
    });
    expect(isCampaignRef(parsed.operator)).toBe(true);
    expect(isCampaignRef(parsed.target)).toBe(true);
  });

  it('rejects an enum-mapped ref whose map VALUE is not a slot literal (schema-enforced)', () => {
    const result = ThresholdCriterionSchema.safeParse({
      type: 'threshold',
      name: 'bad-map',
      metric: 'lbValue',
      operator: { $campaign: 'metricDirection', map: { maximize: 'NOT_AN_OPERATOR' } },
      target: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed ref key (non-identifier field name)', () => {
    const result = ThresholdCriterionSchema.safeParse({
      type: 'threshold',
      name: 'bad-key',
      metric: 'lbValue',
      operator: 'gt',
      target: { $campaign: 'has spaces!' },
    });
    expect(result.success).toBe(false);
  });

  it('Outcome evaluator accepts $campaign refs on operator/target', () => {
    const parsed = OutcomeSchema.parse({
      id: 'lb-target',
      name: 'Leaderboard target',
      evaluator: {
        type: 'threshold',
        metric: 'lbValue',
        operator: { $campaign: 'metricDirection', map: { maximize: 'gte', minimize: 'lte' } },
        target: { $campaign: 'targetScore' },
      },
    });
    expect(outcomeHasCampaignRefs(parsed)).toBe(true);
  });
});

// ============================================================================
// resolveCampaignGoal — the materialization choke-point
// ============================================================================

describe('resolveCampaignGoal', () => {
  const paramGoal: SkillGoal = {
    type: 'numeric',
    metricKey: 'lbValue',
    direction: { $campaign: 'metricDirection' },
  };

  it('resolves a value-ref direction from config (maximize instance)', () => {
    const result = resolveCampaignGoal({ goal: paramGoal }, KAGGLE_CONFIG);
    expect(result).toEqual({
      ok: true,
      goal: { type: 'numeric', metricKey: 'lbValue', direction: 'maximize' },
    });
  });

  it('resolves the SAME skill to minimize on a minimize instance (no inversion)', () => {
    const result = resolveCampaignGoal({ goal: paramGoal }, MINIMIZE_CONFIG);
    expect(result).toEqual({
      ok: true,
      goal: { type: 'numeric', metricKey: 'lbValue', direction: 'minimize' },
    });
  });

  it('resolves an enum-mapped direction ref', () => {
    const mapped: SkillGoal = {
      type: 'numeric',
      metricKey: 'lbValue',
      direction: { $campaign: 'metricName', map: { Accuracy: 'maximize', RMSE: 'minimize' } },
    };
    expect(resolveCampaignGoal({ goal: mapped }, KAGGLE_CONFIG)).toEqual({
      ok: true,
      goal: { type: 'numeric', metricKey: 'lbValue', direction: 'maximize' },
    });
    expect(resolveCampaignGoal({ goal: mapped }, MINIMIZE_CONFIG)).toEqual({
      ok: true,
      goal: { type: 'numeric', metricKey: 'lbValue', direction: 'minimize' },
    });
  });

  it('fails closed on a missing config field (never fakes a direction)', () => {
    const result = resolveCampaignGoal({ goal: paramGoal }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('metricDirection');
  });

  it('fails on a config value outside the slot enum', () => {
    const result = resolveCampaignGoal({ goal: paramGoal }, { metricDirection: 'sideways' });
    expect(result.ok).toBe(false);
  });

  it('passes non-numeric goals through unchanged', () => {
    const goal: SkillGoal = { type: 'subjective', rubric: ['quality'] };
    expect(resolveCampaignGoal({ goal }, {})).toEqual({ ok: true, goal });
  });

  it('passes a concrete numeric goal through {} unchanged', () => {
    const goal: SkillGoal = { type: 'numeric', metricKey: 'lbValue', direction: 'minimize' };
    expect(resolveCampaignGoal({ goal }, {})).toEqual({ ok: true, goal });
  });
});

// ============================================================================
// Criterion / outcome resolution
// ============================================================================

describe('resolveEvalCriterionParams', () => {
  const criterion: EvalCriterion = {
    type: 'threshold',
    name: 'lb-target-met',
    metric: 'lbValue',
    operator: { $campaign: 'metricDirection', map: { maximize: 'gte', minimize: 'lte' } },
    target: { $campaign: 'targetScore' },
  };

  it('resolves mapped operator + value target (maximize)', () => {
    const result = resolveEvalCriterionParams(criterion, KAGGLE_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok && result.criterion.type === 'threshold') {
      expect(result.criterion.operator).toBe('gte');
      expect(result.criterion.target).toBe(0.8);
    }
  });

  it('resolves to lte on a minimize instance', () => {
    const result = resolveEvalCriterionParams(criterion, MINIMIZE_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok && result.criterion.type === 'threshold') {
      expect(result.criterion.operator).toBe('lte');
      expect(result.criterion.target).toBe(0.12);
    }
  });

  it('fails on a non-numeric target value', () => {
    const result = resolveEvalCriterionParams(criterion, {
      ...KAGGLE_CONFIG,
      targetScore: 'not-a-number',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('target');
  });

  it('passes non-threshold criteria through', () => {
    const contains: EvalCriterion = {
      type: 'contains',
      name: 'has-summary',
      pattern: 'done',
      inField: 'summary',
    };
    expect(criterionHasCampaignRefs(contains)).toBe(false);
    expect(resolveEvalCriterionParams(contains, {})).toEqual({ ok: true, criterion: contains });
  });
});

describe('resolveOutcomeEvaluatorParams + resolveCampaignTargetBar', () => {
  const outcome: Outcome = {
    id: 'lb-target',
    name: 'Leaderboard target',
    evaluator: {
      type: 'threshold',
      metric: 'lbValue',
      operator: { $campaign: 'metricDirection', map: { maximize: 'gte', minimize: 'lte' } },
      target: { $campaign: 'targetScore' },
    },
  };

  it('resolves the evaluator against config', () => {
    const result = resolveOutcomeEvaluatorParams(outcome, MINIMIZE_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok && result.outcome.evaluator.type === 'threshold') {
      expect(result.outcome.evaluator.operator).toBe('lte');
      expect(result.outcome.evaluator.target).toBe(0.12);
    }
  });

  it('resolveCampaignTargetBar finds the bar on the goal metric', () => {
    const bar = resolveCampaignTargetBar([outcome], 'lbValue', KAGGLE_CONFIG);
    expect(bar).toEqual({ outcomeId: 'lb-target', operator: 'gte', target: 0.8 });
  });

  it('resolveCampaignTargetBar returns null for an unresolvable bar (never goal-met by accident)', () => {
    expect(resolveCampaignTargetBar([outcome], 'lbValue', {})).toBeNull();
  });

  it('resolveCampaignTargetBar ignores outcomes on other metrics', () => {
    expect(resolveCampaignTargetBar([outcome], 'validationScore', KAGGLE_CONFIG)).toBeNull();
  });
});

describe('compareWithThresholdOperator', () => {
  it('covers every operator', () => {
    expect(compareWithThresholdOperator(1, 'lt', 2)).toBe(true);
    expect(compareWithThresholdOperator(2, 'lte', 2)).toBe(true);
    expect(compareWithThresholdOperator(3, 'gt', 2)).toBe(true);
    expect(compareWithThresholdOperator(2, 'gte', 2)).toBe(true);
    expect(compareWithThresholdOperator(2, 'eq', 2)).toBe(true);
    expect(compareWithThresholdOperator(2, 'between', 1, 3)).toBe(true);
    expect(compareWithThresholdOperator(4, 'between', 1, 3)).toBe(false);
  });
});
