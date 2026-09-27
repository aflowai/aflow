/**
 * D11 scorecard math on hand-computed fixtures: Wilson bounds, Cohen's κ
 * (including the degenerate all-pass / all-fail matrices where κ is
 * undefined), the seeded bootstrap, and the partition-integrity invariant —
 * exemplar labels can NEVER enter a confusion matrix, because the filter
 * lives inside the pure function.
 */
import { describe, expect, it } from 'vitest';
import {
  KAPPA_BOOTSTRAP_RESAMPLES,
  bootstrapKappaInterval,
  cohenKappa,
  computeJudgeScorecards,
  createSeededRng,
  deriveSubjectConfigKey,
  seedFromString,
  wilsonInterval,
  type JudgeMeasurementLabel,
  type JudgeMeasurementVerdict,
  type VerdictPair,
} from '../judgeScorecard.js';

const TRUST = { judgeTrustKappa: 0.6, judgeTrustMinLabels: 5 };

// ============================================================================
// Wilson
// ============================================================================

describe('wilsonInterval', () => {
  it('matches the hand-computed 95% interval for 8/10', () => {
    const interval = wilsonInterval(8, 10);
    expect(interval).not.toBeNull();
    expect(interval!.estimate).toBeCloseTo(0.8, 10);
    expect(interval!.lower).toBeCloseTo(0.4902, 4);
    expect(interval!.upper).toBeCloseTo(0.9433, 4);
    expect(interval!.n).toBe(10);
  });

  it('stays inside [0, 1] at the boundaries', () => {
    const allPass = wilsonInterval(10, 10)!;
    expect(allPass.estimate).toBe(1);
    expect(allPass.upper).toBeCloseTo(1, 10);
    expect(allPass.lower).toBeGreaterThan(0.65);
    const none = wilsonInterval(0, 10)!;
    expect(none.estimate).toBe(0);
    expect(none.lower).toBeCloseTo(0, 10);
    expect(none.upper).toBeLessThan(0.35);
  });

  it('is null on an empty denominator', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

// ============================================================================
// Cohen's κ
// ============================================================================

function pairs(counts: { tp: number; fp: number; tn: number; fn: number }): VerdictPair[] {
  return [
    ...Array.from({ length: counts.tp }, (): VerdictPair => ({ label: 'fail', judge: 'fail' })),
    ...Array.from({ length: counts.fp }, (): VerdictPair => ({ label: 'pass', judge: 'fail' })),
    ...Array.from({ length: counts.tn }, (): VerdictPair => ({ label: 'pass', judge: 'pass' })),
    ...Array.from({ length: counts.fn }, (): VerdictPair => ({ label: 'fail', judge: 'pass' })),
  ];
}

describe('cohenKappa', () => {
  it('matches the hand-computed value: po=0.75, pe=0.5 → κ=0.5', () => {
    // 20 pairs: tp=8, fp=2, tn=7, fn=3. po = 15/20; marginals 11/20 & 10/20
    // fail, 9/20 & 10/20 pass → pe = 0.275 + 0.225 = 0.5.
    expect(cohenKappa(pairs({ tp: 8, fp: 2, tn: 7, fn: 3 }))).toBeCloseTo(0.5, 10);
  });

  it('is 1 on perfect agreement with mixed marginals', () => {
    expect(cohenKappa(pairs({ tp: 5, fp: 0, tn: 5, fn: 0 }))).toBeCloseTo(1, 10);
  });

  it('is undefined (null) on the degenerate all-pass matrix', () => {
    expect(cohenKappa(pairs({ tp: 0, fp: 0, tn: 12, fn: 0 }))).toBeNull();
  });

  it('is undefined (null) on the degenerate all-fail matrix', () => {
    expect(cohenKappa(pairs({ tp: 12, fp: 0, tn: 0, fn: 0 }))).toBeNull();
  });

  it('is null with no pairs', () => {
    expect(cohenKappa([])).toBeNull();
  });
});

describe('bootstrapKappaInterval', () => {
  it('is deterministic under the same seed and brackets the estimate', () => {
    const sample = pairs({ tp: 8, fp: 2, tn: 7, fn: 3 });
    const first = bootstrapKappaInterval(sample, createSeededRng(42));
    const second = bootstrapKappaInterval(sample, createSeededRng(42));
    expect(first).toEqual(second);
    expect(first).not.toBeNull();
    expect(first!.lower).toBeLessThanOrEqual(0.5);
    expect(first!.upper).toBeGreaterThanOrEqual(0.5);
    expect(first!.lower).toBeGreaterThanOrEqual(-1);
    expect(first!.upper).toBeLessThanOrEqual(1);
  });

  it('differs under a different seed (it is a real resample)', () => {
    const sample = pairs({ tp: 8, fp: 2, tn: 7, fn: 3 });
    const a = bootstrapKappaInterval(sample, createSeededRng(1));
    const b = bootstrapKappaInterval(sample, createSeededRng(2));
    expect(a).not.toEqual(b);
  });

  it('is null below two pairs', () => {
    expect(
      bootstrapKappaInterval(pairs({ tp: 1, fp: 0, tn: 0, fn: 0 }), createSeededRng(1)),
    ).toBeNull();
  });

  it('reports the ACTUAL defined-resample count — degenerate resamples drop out', () => {
    // Two agreeing pairs with mixed marginals: half the size-2 resamples are
    // single-pair (degenerate, κ undefined) and must not be claimed.
    const sample = pairs({ tp: 1, fp: 0, tn: 1, fn: 0 });
    const interval = bootstrapKappaInterval(sample, createSeededRng(7));
    expect(interval).not.toBeNull();
    expect(interval!.resamples).toBeGreaterThan(0);
    expect(interval!.resamples).toBeLessThan(KAPPA_BOOTSTRAP_RESAMPLES);
    // Deterministic under the seed.
    expect(bootstrapKappaInterval(sample, createSeededRng(7))!.resamples).toBe(interval!.resamples);
  });

  it('reports the full resample count when every resample is defined', () => {
    const interval = bootstrapKappaInterval(
      pairs({ tp: 8, fp: 2, tn: 7, fn: 3 }),
      createSeededRng(42),
    );
    expect(interval!.resamples).toBe(KAPPA_BOOTSTRAP_RESAMPLES);
  });
});

// ============================================================================
// Subject configuration key
// ============================================================================

describe('deriveSubjectConfigKey', () => {
  it('is order-insensitive over the subject models', () => {
    const a = deriveSubjectConfigKey([
      { scope: 'runner', modelRef: 'model-a' },
      { scope: 'task:t1', modelRef: 'model-b' },
    ]);
    const b = deriveSubjectConfigKey([
      { scope: 'task:t1', modelRef: 'model-b' },
      { scope: 'runner', modelRef: 'model-a' },
    ]);
    expect(a).toBe(b);
  });

  it('changes when any modelRef changes', () => {
    const a = deriveSubjectConfigKey([{ scope: 'runner', modelRef: 'model-a' }]);
    const b = deriveSubjectConfigKey([{ scope: 'runner', modelRef: 'model-c' }]);
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// computeJudgeScorecards
// ============================================================================

const CONFIG_KEY = 'config-1';
const SUBJECT_MODELS = new Map([[CONFIG_KEY, [{ scope: 'runner', modelRef: 'subject-model' }]]]);

function label(
  trial: number,
  verdict: 'pass' | 'fail',
  partition: 'exemplar' | 'validation',
  criterionId = 'clarity',
  scopeKey = 'case_local',
): JudgeMeasurementLabel {
  return {
    batchId: 'batch-1',
    caseRevisionId: 'rev-1',
    trial,
    criterionId,
    scopeKey,
    verdict,
    partition,
    subjectConfigKey: CONFIG_KEY,
  };
}

function verdict(
  trial: number,
  judged: 'pass' | 'fail',
  judgeVersion = 'v1',
  criterionId = 'clarity',
  scopeKey = 'case_local',
): JudgeMeasurementVerdict {
  return {
    batchId: 'batch-1',
    caseRevisionId: 'rev-1',
    trial,
    criterionId,
    scopeKey,
    judgeVersion,
    verdict: judged,
  };
}

describe('computeJudgeScorecards', () => {
  it('builds the confusion matrix over validation labels joined to same-version verdicts', () => {
    const labels = [
      label(1, 'fail', 'validation'),
      label(2, 'fail', 'validation'),
      label(3, 'pass', 'validation'),
      label(4, 'pass', 'validation'),
      label(5, 'pass', 'validation'),
    ];
    const verdicts = [
      verdict(1, 'fail'), // tp
      verdict(2, 'pass'), // fn
      verdict(3, 'fail'), // fp
      verdict(4, 'pass'), // tn
      // trial 5: no verdict → unpaired
    ];
    const [scorecard] = computeJudgeScorecards({
      labels,
      verdicts,
      subjectModelsByConfigKey: SUBJECT_MODELS,
      trust: TRUST,
    });
    expect(scorecard).toBeDefined();
    expect(scorecard!.criterionId).toBe('clarity');
    expect(scorecard!.scopeKey).toBe('case_local');
    expect(scorecard!.judgeVersion).toBe('v1');
    expect(scorecard!.subjectConfigKey).toBe(CONFIG_KEY);
    expect(scorecard!.validationLabels).toBe(5);
    expect(scorecard!.pairedLabels).toBe(4);
    expect(scorecard!.unpairedLabels).toBe(1);
    expect(scorecard!.confusion).toEqual({
      truePositive: 1,
      falsePositive: 1,
      trueNegative: 1,
      falseNegative: 1,
    });
    expect(scorecard!.precision!.estimate).toBeCloseTo(0.5, 10);
    expect(scorecard!.recall!.estimate).toBeCloseTo(0.5, 10);
    expect(scorecard!.tnr!.estimate).toBeCloseTo(0.5, 10);
  });

  it('NEVER lets exemplar labels into a scorecard — matching verdicts and all', () => {
    const labels = [
      label(1, 'fail', 'exemplar'),
      label(2, 'fail', 'exemplar'),
      label(3, 'pass', 'exemplar'),
    ];
    const verdicts = [verdict(1, 'fail'), verdict(2, 'fail'), verdict(3, 'pass')];
    const scorecards = computeJudgeScorecards({
      labels,
      verdicts,
      subjectModelsByConfigKey: SUBJECT_MODELS,
      trust: TRUST,
    });
    expect(scorecards).toEqual([]);
  });

  it('counts exemplar labels in NO group even when validation labels coexist', () => {
    const labels = [label(1, 'fail', 'validation'), label(2, 'fail', 'exemplar')];
    const verdicts = [verdict(1, 'fail'), verdict(2, 'fail')];
    const [scorecard] = computeJudgeScorecards({
      labels,
      verdicts,
      subjectModelsByConfigKey: SUBJECT_MODELS,
      trust: TRUST,
    });
    expect(scorecard!.validationLabels).toBe(1);
    expect(scorecard!.pairedLabels).toBe(1);
    expect(scorecard!.confusion.truePositive).toBe(1);
  });

  it('same-named criteria at different scopes hold SEPARATE scorecards — labels never cross-pair', () => {
    const labels = [
      label(1, 'fail', 'validation', 'quality', 'goal'),
      label(1, 'pass', 'validation', 'quality', 'trajectory'),
    ];
    const verdicts = [
      verdict(1, 'fail', 'v1', 'quality', 'goal'),
      verdict(1, 'pass', 'v1', 'quality', 'trajectory'),
    ];
    const scorecards = computeJudgeScorecards({
      labels,
      verdicts,
      subjectModelsByConfigKey: SUBJECT_MODELS,
      trust: TRUST,
    });
    expect(scorecards.map((s) => [s.criterionId, s.scopeKey])).toEqual([
      ['quality', 'goal'],
      ['quality', 'trajectory'],
    ]);
    const goal = scorecards.find((s) => s.scopeKey === 'goal')!;
    const trajectory = scorecards.find((s) => s.scopeKey === 'trajectory')!;
    // Each scope's single label pairs against ITS scope's verdict only.
    expect(goal.validationLabels).toBe(1);
    expect(goal.pairedLabels).toBe(1);
    expect(goal.confusion).toEqual({
      truePositive: 1,
      falsePositive: 0,
      trueNegative: 0,
      falseNegative: 0,
    });
    expect(trajectory.confusion).toEqual({
      truePositive: 0,
      falsePositive: 0,
      trueNegative: 1,
      falseNegative: 0,
    });
  });

  it('produces one scorecard per judgeVersion so re-judged versions compare', () => {
    const labels = [label(1, 'fail', 'validation'), label(2, 'pass', 'validation')];
    const verdicts = [
      verdict(1, 'fail', 'v1'),
      verdict(2, 'pass', 'v1'),
      verdict(1, 'pass', 'v2'),
      verdict(2, 'pass', 'v2'),
    ];
    const scorecards = computeJudgeScorecards({
      labels,
      verdicts,
      subjectModelsByConfigKey: SUBJECT_MODELS,
      trust: TRUST,
    });
    expect(scorecards.map((s) => s.judgeVersion)).toEqual(['v1', 'v2']);
    const v1 = scorecards.find((s) => s.judgeVersion === 'v1')!;
    const v2 = scorecards.find((s) => s.judgeVersion === 'v2')!;
    expect(v1.confusion).toEqual({
      truePositive: 1,
      falsePositive: 0,
      trueNegative: 1,
      falseNegative: 0,
    });
    expect(v2.confusion).toEqual({
      truePositive: 0,
      falsePositive: 0,
      trueNegative: 1,
      falseNegative: 1,
    });
  });

  it('kappa.resamples is the ACTUAL defined-resample count, not the attempt budget', () => {
    // Two agreeing pairs with mixed marginals: about half the size-2
    // resamples are degenerate and drop out of the percentiles.
    const labels = [label(1, 'fail', 'validation'), label(2, 'pass', 'validation')];
    const verdicts = [verdict(1, 'fail'), verdict(2, 'pass')];
    const [scorecard] = computeJudgeScorecards({
      labels,
      verdicts,
      subjectModelsByConfigKey: SUBJECT_MODELS,
      trust: TRUST,
    });
    expect(scorecard!.kappa.resamples).toBeGreaterThan(0);
    expect(scorecard!.kappa.resamples).toBeLessThan(KAPPA_BOOTSTRAP_RESAMPLES);
  });

  it('kappa is undefined on a degenerate all-pass group and the gate reads inert-honest', () => {
    const labels = [1, 2, 3, 4, 5].map((t) => label(t, 'pass', 'validation'));
    const verdicts = [1, 2, 3, 4, 5].map((t) => verdict(t, 'pass'));
    const [scorecard] = computeJudgeScorecards({
      labels,
      verdicts,
      subjectModelsByConfigKey: SUBJECT_MODELS,
      trust: TRUST,
    });
    expect(scorecard!.kappa.estimate).toBeUndefined();
    expect(scorecard!.kappa.resamples).toBe(0);
    expect(scorecard!.gate.labelsShort).toBe(0);
    expect(scorecard!.gate.wouldPass).toBe(false);
    expect(scorecard!.precision).toBeUndefined();
    expect(scorecard!.recall).toBeUndefined();
    expect(scorecard!.tnr!.estimate).toBe(1);
  });

  it('gate distance readout: labelsShort counts to judgeTrustMinLabels; a strong judge wouldPass', () => {
    const labels = [
      label(1, 'fail', 'validation'),
      label(2, 'fail', 'validation'),
      label(3, 'fail', 'validation'),
      label(4, 'pass', 'validation'),
      label(5, 'pass', 'validation'),
      label(6, 'pass', 'validation'),
    ];
    const verdicts = [
      verdict(1, 'fail'),
      verdict(2, 'fail'),
      verdict(3, 'fail'),
      verdict(4, 'pass'),
      verdict(5, 'pass'),
      verdict(6, 'pass'),
    ];
    const [scorecard] = computeJudgeScorecards({
      labels,
      verdicts,
      subjectModelsByConfigKey: SUBJECT_MODELS,
      trust: TRUST,
    });
    expect(scorecard!.kappa.estimate).toBeCloseTo(1, 10);
    expect(scorecard!.gate.labelsShort).toBe(0);
    expect(scorecard!.gate.kappaLowerBound).toBe(1);
    expect(scorecard!.gate.wouldPass).toBe(true);

    const short = computeJudgeScorecards({
      labels: labels.slice(0, 3),
      verdicts,
      subjectModelsByConfigKey: SUBJECT_MODELS,
      trust: { judgeTrustKappa: 0.6, judgeTrustMinLabels: 50 },
    })[0]!;
    expect(short.gate.labelsShort).toBe(47);
    expect(short.gate.wouldPass).toBe(false);
  });

  it('is deterministic across recomputes (group-seeded bootstrap)', () => {
    const labels = [
      label(1, 'fail', 'validation'),
      label(2, 'fail', 'validation'),
      label(3, 'pass', 'validation'),
      label(4, 'pass', 'validation'),
      label(5, 'fail', 'validation'),
      label(6, 'pass', 'validation'),
    ];
    const verdicts = [
      verdict(1, 'fail'),
      verdict(2, 'pass'),
      verdict(3, 'fail'),
      verdict(4, 'pass'),
      verdict(5, 'fail'),
      verdict(6, 'pass'),
    ];
    const run = () =>
      computeJudgeScorecards({
        labels,
        verdicts,
        subjectModelsByConfigKey: SUBJECT_MODELS,
        trust: TRUST,
      });
    expect(run()).toEqual(run());
  });
});

describe('seedFromString', () => {
  it('is stable and input-sensitive', () => {
    expect(seedFromString('batch-1')).toBe(seedFromString('batch-1'));
    expect(seedFromString('batch-1')).not.toBe(seedFromString('batch-2'));
  });
});
