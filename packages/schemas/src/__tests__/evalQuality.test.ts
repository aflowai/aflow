import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { computeEvalQualityReport } from '../cybernetic/evalQuality.js';
import type { CriterionResult, EvalResult } from '../cybernetic/eval.js';

const SUITE = {
  goalCriteria: [
    {
      type: 'threshold' as const,
      name: 'acc',
      metric: 'accuracy',
      operator: 'gte' as const,
      target: 0.7,
    },
  ],
  taskCriteria: {
    'render-card': [
      {
        type: 'contains' as const,
        name: 'card-emitted',
        inField: 'summary',
        pattern: 'card',
      },
    ],
  },
  trajectoryCriteria: [],
};

function criterion(name: string, passed: boolean, type = 'threshold'): CriterionResult {
  return { criterionName: name, criterionType: type, passed, score: passed ? 1 : 0 };
}

function result(input: {
  goal?: CriterionResult[];
  task?: Record<string, CriterionResult[]>;
  verdict?: EvalResult['verdict'];
}): EvalResult {
  return {
    id: randomUUID(),
    runId: randomUUID(),
    sessionId: randomUUID(),
    verdict: input.verdict ?? 'pass',
    goalResults: input.goal ?? [],
    taskResults: input.task ?? {},
    trajectoryResults: [],
    scores: { overall: 1 },
    confidence: 'high',
    evaluatedAt: new Date().toISOString(),
    evaluationDurationMs: 5,
  };
}

describe('computeEvalQualityReport', () => {
  it('flags an always-passing criterion AFTER N samples', () => {
    const results = Array.from({ length: 4 }, () => result({ goal: [criterion('acc', true)] }));
    const report = computeEvalQualityReport(SUITE, results, { minSamples: 4 });
    const acc = report.criteria.find((c) => c.name === 'acc');
    expect(acc).toMatchObject({ tier: 'goal', samples: 4, passes: 4, alwaysPasses: true });
  });

  it('does NOT flag before N samples (post-sample report, never author-time)', () => {
    const results = Array.from({ length: 3 }, () => result({ goal: [criterion('acc', true)] }));
    const report = computeEvalQualityReport(SUITE, results, { minSamples: 4 });
    const acc = report.criteria.find((c) => c.name === 'acc');
    expect(acc?.alwaysPasses).toBe(false);
  });

  it('a single failure unflags the criterion', () => {
    const results = [
      ...Array.from({ length: 5 }, () => result({ goal: [criterion('acc', true)] })),
      result({ goal: [criterion('acc', false)], verdict: 'fail' }),
    ];
    const report = computeEvalQualityReport(SUITE, results, { minSamples: 4 });
    const acc = report.criteria.find((c) => c.name === 'acc');
    expect(acc?.alwaysPasses).toBe(false);
    expect(acc?.passes).toBe(5);
    expect(acc?.samples).toBe(6);
  });

  it('task-tier criteria are keyed task:<taskId> and tracked independently', () => {
    const results = Array.from({ length: 4 }, () =>
      result({
        goal: [criterion('acc', true)],
        task: { 'render-card': [criterion('card-emitted', true, 'contains')] },
      }),
    );
    const report = computeEvalQualityReport(SUITE, results, { minSamples: 4 });
    const card = report.criteria.find((c) => c.tier === 'task:render-card');
    expect(card).toMatchObject({ name: 'card-emitted', alwaysPasses: true });
  });

  it('non-evaluated kinds (judge_error) and error verdicts are excluded', () => {
    const results = [
      ...Array.from({ length: 4 }, () => result({ goal: [criterion('acc', true, 'judge_error')] })),
      result({ goal: [criterion('acc', true)], verdict: 'error' }),
    ];
    const report = computeEvalQualityReport(SUITE, results, { minSamples: 2 });
    expect(report.criteria.find((c) => c.name === 'acc')).toBeUndefined();
  });

  it('criteria the suite no longer declares are not reported', () => {
    const results = Array.from({ length: 5 }, () =>
      result({ goal: [criterion('removed-criterion', true)] }),
    );
    const report = computeEvalQualityReport(SUITE, results, { minSamples: 2 });
    expect(report.criteria.find((c) => c.name === 'removed-criterion')).toBeUndefined();
  });
});
