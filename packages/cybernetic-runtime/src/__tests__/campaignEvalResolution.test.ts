import { describe, it, expect } from 'vitest';
import type { CyberneticEvalSuite, EvalCriterion } from '@aflow/schemas';
import { evaluateCriterion } from '../evalRunnerCriterion.js';
import { resolveSuiteCampaignRefs, suiteHasCampaignRefs } from '../evalRunnerCampaignResolution.js';

const PARAM_CRITERION: EvalCriterion = {
  type: 'threshold',
  name: 'lb-target-met',
  metric: 'lbValue',
  operator: { $campaign: 'metricDirection', map: { maximize: 'gte', minimize: 'lte' } },
  target: { $campaign: 'targetScore' },
};

function makeSuite(overrides: Partial<CyberneticEvalSuite> = {}): CyberneticEvalSuite {
  return {
    goalCriteria: [],
    taskCriteria: {},
    trajectoryCriteria: [],
    weights: { goal: 0.4, task: 0.4, trajectory: 0.2 },
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    createdBy: 'platform',
    ...overrides,
  };
}

describe('suiteHasCampaignRefs', () => {
  it('detects refs in any tier', () => {
    expect(suiteHasCampaignRefs(makeSuite())).toBe(false);
    expect(suiteHasCampaignRefs(makeSuite({ goalCriteria: [PARAM_CRITERION] }))).toBe(true);
    expect(
      suiteHasCampaignRefs(makeSuite({ taskCriteria: { 'poll-lb-score': [PARAM_CRITERION] } })),
    ).toBe(true);
    expect(suiteHasCampaignRefs(makeSuite({ trajectoryCriteria: [PARAM_CRITERION] }))).toBe(true);
  });
});

describe('resolveSuiteCampaignRefs → evaluateCriterion (end-to-end)', () => {
  it('maximize instance: gte target resolves and a meeting run passes', () => {
    const suite = makeSuite({ taskCriteria: { 'poll-lb-score': [PARAM_CRITERION] } });
    const resolution = resolveSuiteCampaignRefs(suite, {
      metricDirection: 'maximize',
      targetScore: 0.8,
    });
    expect(resolution.prefailedTask).toEqual({});
    const resolved = resolution.suite.taskCriteria['poll-lb-score']![0]!;

    const pass = evaluateCriterion(resolved, { output: { lbValue: 0.82 } });
    expect(pass?.passed).toBe(true);
    expect(pass?.observedValue).toBe(0.82);

    const fail = evaluateCriterion(resolved, { output: { lbValue: 0.78 } });
    expect(fail?.passed).toBe(false);
  });

  it('minimize instance: SAME criterion resolves to lte (no inversion)', () => {
    const suite = makeSuite({ taskCriteria: { 'poll-lb-score': [PARAM_CRITERION] } });
    const resolution = resolveSuiteCampaignRefs(suite, {
      metricDirection: 'minimize',
      targetScore: 0.12,
    });
    const resolved = resolution.suite.taskCriteria['poll-lb-score']![0]!;

    // A LOW score meets a minimize target — would have failed under the old
    expect(evaluateCriterion(resolved, { output: { lbValue: 0.11 } })?.passed).toBe(true);
    expect(evaluateCriterion(resolved, { output: { lbValue: 0.5 } })?.passed).toBe(false);
  });

  it('no campaign in scope (config null): criterion pre-fails with the reason', () => {
    const suite = makeSuite({ goalCriteria: [PARAM_CRITERION] });
    const resolution = resolveSuiteCampaignRefs(suite, null);
    expect(resolution.suite.goalCriteria).toHaveLength(0);
    expect(resolution.prefailedGoal).toHaveLength(1);
    expect(resolution.prefailedGoal[0]!.passed).toBe(false);
    expect(resolution.prefailedGoal[0]!.evidence).toContain('no campaign in scope');
  });

  it('missing config field: criterion pre-fails carrying the field name', () => {
    const suite = makeSuite({ trajectoryCriteria: [PARAM_CRITERION] });
    const resolution = resolveSuiteCampaignRefs(suite, { metricDirection: 'maximize' });
    expect(resolution.suite.trajectoryCriteria).toHaveLength(0);
    expect(resolution.prefailedTrajectory[0]!.evidence).toContain('targetScore');
  });

  it('literal criteria pass through untouched (no campaign read needed)', () => {
    const literal: EvalCriterion = {
      type: 'threshold',
      name: 'sanity',
      metric: 'validationScore',
      operator: 'gt',
      target: 0,
    };
    const suite = makeSuite({ goalCriteria: [literal] });
    const resolution = resolveSuiteCampaignRefs(suite, null);
    expect(resolution.suite.goalCriteria).toEqual([literal]);
    expect(resolution.prefailedGoal).toEqual([]);
  });

  it('evaluateCriterion stays dumb: an unresolved ref reaching it fails honestly', () => {
    const result = evaluateCriterion(PARAM_CRITERION, { output: { lbValue: 0.9 } });
    expect(result?.passed).toBe(false);
    expect(result?.evidence).toContain('unresolved $campaign reference');
  });
});
