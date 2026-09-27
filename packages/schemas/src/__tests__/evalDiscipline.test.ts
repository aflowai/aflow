import { describe, it, expect } from 'vitest';
import { validateEvalSuiteDiscipline } from '../cybernetic/evalDiscipline.js';
import type { EvalCriterion } from '../cybernetic/eval.js';

const threshold = (name: string): EvalCriterion => ({
  type: 'threshold',
  name,
  metric: 'accuracy',
  operator: 'gte',
  target: 0.7,
});

const judge = (name: string): EvalCriterion => ({
  type: 'judge',
  name,
  rubric: [{ criterion: 'quality', scale: 'binary', description: 'is it good' }],
});

const weights = (goal: number, task: number, trajectory: number) => ({ goal, task, trajectory });

describe('validateEvalSuiteDiscipline', () => {
  it('a deterministic-only suite is disciplined', () => {
    expect(
      validateEvalSuiteDiscipline({
        goalCriteria: [threshold('acc')],
        taskCriteria: {},
        trajectoryCriteria: [],
        weights: weights(1, 0, 0),
      }),
    ).toEqual([]);
  });

  it('a suite with ONLY judge criteria is rejected (determinism-first)', () => {
    const issues = validateEvalSuiteDiscipline({
      goalCriteria: [judge('vibes')],
      taskCriteria: {},
      trajectoryCriteria: [],
      weights: weights(1, 0, 0),
    });
    expect(issues.some((i) => i.code === 'judge_without_deterministic_anchor')).toBe(true);
  });

  it('a judge criterion as the primary score is rejected (judge-only weighted tier)', () => {
    const issues = validateEvalSuiteDiscipline({
      goalCriteria: [judge('vibes')],
      taskCriteria: { 'task-1': [threshold('acc')] },
      trajectoryCriteria: [],
      // goal tier (judge-only) carries the dominant weight → judge primary.
      weights: weights(0.6, 0.4, 0),
    });
    expect(issues.some((i) => i.code === 'judge_primary_score')).toBe(true);
    expect(issues.some((i) => i.code === 'judge_without_deterministic_anchor')).toBe(false);
  });

  it('a judge-only tier at weight 0 is legal (secondary/advisory)', () => {
    expect(
      validateEvalSuiteDiscipline({
        goalCriteria: [judge('vibes')],
        taskCriteria: { 'task-1': [threshold('acc')] },
        trajectoryCriteria: [],
        weights: weights(0, 1, 0),
      }),
    ).toEqual([]);
  });

  it('a judge beside a deterministic criterion in the same weighted tier is legal', () => {
    expect(
      validateEvalSuiteDiscipline({
        goalCriteria: [threshold('acc'), judge('vibes')],
        taskCriteria: {},
        trajectoryCriteria: [],
        weights: weights(1, 0, 0),
      }),
    ).toEqual([]);
  });

  it('deterministic anchors parked in 0-weight tiers leave the score judge-steered → rejected', () => {
    const issues = validateEvalSuiteDiscipline({
      goalCriteria: [judge('vibes')],
      taskCriteria: { 'task-1': [threshold('acc')] },
      trajectoryCriteria: [],
      // The deterministic task tier carries NO weight; only the judge tier does.
      weights: weights(1, 0, 0),
    });
    expect(issues.some((i) => i.code === 'judge_primary_score')).toBe(true);
  });

  it('a suite without judges is never flagged regardless of weights', () => {
    expect(
      validateEvalSuiteDiscipline({
        goalCriteria: [],
        taskCriteria: { t: [threshold('acc')] },
        trajectoryCriteria: [],
        weights: weights(0, 0.7, 0.3),
      }),
    ).toEqual([]);
  });
});
