import { describe, it, expect } from 'vitest';
import type { WorkflowTask, SkillGoal } from '@aflow/schemas';
import {
  resolvePromotedRunMetrics,
  derivePrimaryScore,
  bestScoreByDirection,
  coerceNumeric,
  detectTrajectoryRegression,
  type PromotionTaskResult,
} from '../promotion.js';

function task(taskId: string, promoteOutputs: WorkflowTask['promoteOutputs']): WorkflowTask {
  // Only the fields promotion reads are needed; cast the partial.
  return { taskId, promoteOutputs } as unknown as WorkflowTask;
}

describe('resolvePromotedRunMetrics (§3.1)', () => {
  it('promotes a metric / output_path / output_root / task_summary from a succeeded task', () => {
    const tasks = [
      task('poll', [{ kind: 'output_path', path: 'lbValue', toState: 'lbValue' }]),
      task('m', [{ kind: 'metric', metric: 'rmse', toState: 'rmse' }]),
      task('o', [{ kind: 'output_root', toState: 'wholeOutput' }]),
      task('s', [{ kind: 'task_summary', toState: 'note' }]),
    ];
    const results: PromotionTaskResult[] = [
      { taskId: 'poll', status: 'succeeded', output: { lbValue: 0.787 } },
      { taskId: 'm', status: 'succeeded', metrics: { rmse: 0.12 } },
      { taskId: 'o', status: 'succeeded', output: { a: 1 } },
      { taskId: 's', status: 'succeeded', summary: 'done' },
    ];
    const out = resolvePromotedRunMetrics(tasks, results);
    expect(out['lbValue']).toBe(0.787);
    expect(out['rmse']).toBe(0.12);
    expect(out['wholeOutput']).toEqual({ a: 1 });
    expect(out['note']).toBe('done');
  });

  it('does NOT promote from a non-succeeded task', () => {
    const tasks = [task('poll', [{ kind: 'output_path', path: 'lbValue', toState: 'lbValue' }])];
    const out = resolvePromotedRunMetrics(tasks, [
      { taskId: 'poll', status: 'failed', output: { lbValue: 0.787 } },
    ]);
    expect(out['lbValue']).toBeUndefined();
  });

  it('skips tasks without promoteOutputs and missing values', () => {
    const tasks = [
      task('plain', undefined),
      task('poll', [{ kind: 'output_path', path: 'missing', toState: 'x' }]),
    ];
    const out = resolvePromotedRunMetrics(tasks, [
      { taskId: 'plain', status: 'succeeded', output: { y: 1 } },
      { taskId: 'poll', status: 'succeeded', output: {} },
    ]);
    expect(Object.keys(out)).toHaveLength(0);
  });
});

describe('derivePrimaryScore (§3.3)', () => {
  const numericGoal: SkillGoal = { type: 'numeric', metricKey: 'lbValue', direction: 'maximize' };

  it('derives score + provenance from a numeric goal', () => {
    const res = derivePrimaryScore(numericGoal, { lbValue: 0.787 }, { normalizedScore: 1 });
    expect(res).not.toBeNull();
    expect(res?.score).toBe(0.787);
    expect(res?.provenance.metricKey).toBe('lbValue');
    expect(res?.provenance.rawValue).toBe(0.787);
    expect(res?.provenance.direction).toBe('maximize');
    expect(res?.provenance.normalizedScore).toBe(1);
  });

  it('coerces numeric strings', () => {
    const res = derivePrimaryScore(numericGoal, { lbValue: '0.787' });
    expect(res?.score).toBe(0.787);
  });

  it('returns null for a non-numeric goal', () => {
    const subjective: SkillGoal = { type: 'subjective', rubric: ['be good'] };
    expect(derivePrimaryScore(subjective, { lbValue: 0.787 })).toBeNull();
  });

  it('returns null when the metric is absent or non-numeric', () => {
    expect(derivePrimaryScore(numericGoal, {})).toBeNull();
    expect(derivePrimaryScore(numericGoal, { lbValue: 'not-a-number' })).toBeNull();
  });
});

describe('bestScoreByDirection (§3.3)', () => {
  it('maximize → max, minimize → min', () => {
    expect(bestScoreByDirection([0.78, 0.79, 0.77], 'maximize')).toBe(0.79);
    expect(bestScoreByDirection([0.78, 0.79, 0.77], 'minimize')).toBe(0.77);
  });
  it('ignores non-finite and handles empty', () => {
    expect(bestScoreByDirection([NaN, null, undefined, 0.5], 'maximize')).toBe(0.5);
    expect(bestScoreByDirection([], 'maximize')).toBeUndefined();
  });
});

describe('detectTrajectoryRegression (§3.6 — control-chart σ-band)', () => {
  // k = σ-multiples (the only literal); minRuns / recentWindow are structural.
  const opts = { k: 2, minRuns: 6, recentWindow: 3 };

  it('fires on a sustained drop ≥ k·σ below the baseline peak (maximize) — the Kaggle drift', () => {
    // 5 low-noise baseline runs near the peak, then a sustained 3-run drop.
    const reg = detectTrajectoryRegression(
      [0.785, 0.787, 0.786, 0.788, 0.787, 0.78, 0.779, 0.781],
      'maximize',
      opts,
    );
    expect(reg?.regressed).toBe(true);
    expect(reg?.peak).toBeCloseTo(0.788, 6); // best over the BASELINE
    expect(reg?.recentMean).toBeCloseTo(0.78, 6);
    expect(reg!.nSigma).toBeGreaterThan(opts.k); // drift is several σ, not a tuned margin
  });

  it('does NOT fire on a still-improving series (recent mean is a NEW high, not a drop)', () => {
    const reg = detectTrajectoryRegression(
      [0.78, 0.785, 0.79, 0.795, 0.8, 0.805, 0.81, 0.815],
      'maximize',
      opts,
    );
    expect(reg?.regressed).toBe(false);
  });

  it('does NOT fire on a single dip that stays within the noise band (< k·σ)', () => {
    const reg = detectTrajectoryRegression(
      [0.799, 0.801, 0.8, 0.802, 0.799, 0.8, 0.798, 0.801],
      'maximize',
      opts,
    );
    expect(reg?.regressed).toBe(false);
    expect(reg!.nSigma).toBeLessThan(opts.k);
  });

  it('handles minimize (lower is better) — fires when the recent mean rises ≥ k·σ above the trough', () => {
    const reg = detectTrajectoryRegression(
      [0.102, 0.098, 0.101, 0.099, 0.1, 0.115, 0.117, 0.116],
      'minimize',
      opts,
    );
    expect(reg?.regressed).toBe(true);
    expect(reg?.peak).toBeCloseTo(0.098, 6); // best = min over the baseline
    expect(reg!.nSigma).toBeGreaterThan(opts.k);
  });

  it('treats a zero-variance baseline then a drop as unambiguous signal (nSigma = ∞)', () => {
    const reg = detectTrajectoryRegression(
      [0.8, 0.8, 0.8, 0.8, 0.8, 0.79, 0.79, 0.79],
      'maximize',
      opts,
    );
    expect(reg?.regressed).toBe(true);
    expect(Number.isFinite(reg!.nSigma)).toBe(false);
  });

  it('returns null below minRuns or with too short a baseline (can not separate drift from noise)', () => {
    expect(detectTrajectoryRegression([0.78, 0.79, 0.8, 0.81, 0.82], 'maximize', opts)).toBeNull();
    expect(detectTrajectoryRegression([], 'maximize', opts)).toBeNull();
    // 6 runs but a 5-wide recent window leaves a 1-point baseline → no moving range.
    expect(
      detectTrajectoryRegression([0.8, 0.8, 0.8, 0.8, 0.8, 0.7], 'maximize', {
        k: 2,
        minRuns: 6,
        recentWindow: 5,
      }),
    ).toBeNull();
  });
});

describe('coerceNumeric', () => {
  it('handles numbers, numeric strings, and rejects junk', () => {
    expect(coerceNumeric(0.5)).toBe(0.5);
    expect(coerceNumeric('0.5')).toBe(0.5);
    expect(coerceNumeric('')).toBeNull();
    expect(coerceNumeric('x')).toBeNull();
    expect(coerceNumeric(NaN)).toBeNull();
    expect(coerceNumeric(null)).toBeNull();
  });
});
