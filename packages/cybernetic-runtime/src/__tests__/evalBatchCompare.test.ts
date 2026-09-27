/**
 * D12 paired comparison on hand-built fixtures: pairing on identical case
 * revisions only, per-case flips with transcript runIds, case-clustered
 * bootstrap determinism under a seed, explicit exclusion of
 * added/removed/edited/undecided cases, the degenerate zero-intersection
 * shape, and the capability→regression graduation flag.
 */
import { describe, expect, it } from 'vitest';
import type { EvalBatchCompareSide } from '@aflow/schemas';
import {
  COMPARISON_BOOTSTRAP_RESAMPLES,
  compareEvalBatches,
  deriveGraduationCandidates,
  type CompareCaseMeta,
  type CompareTrialRow,
} from '../evalBatchCompare.js';
import { createSeededRng } from '../judgeScorecard.js';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const BATCH_A: EvalBatchCompareSide = {
  batchId: uuid(1001),
  datasetVersion: 3,
  workflowRevision: 5,
  trialsPerCase: 2,
  status: 'completed',
};
const BATCH_B: EvalBatchCompareSide = {
  batchId: uuid(1002),
  datasetVersion: 3,
  workflowRevision: 6,
  trialsPerCase: 2,
  status: 'completed',
};

const REV_STABLE = uuid(1);
const REV_FLIP_DOWN = uuid(2);
const REV_FLIP_UP = uuid(3);
const REV_EDITED_A = uuid(4);
const REV_EDITED_B = uuid(5);
const REV_REMOVED = uuid(6);
const REV_ADDED = uuid(7);
const REV_UNDECIDED = uuid(8);
const REV_CAPABILITY = uuid(9);

function meta(
  revisionId: string,
  caseNumber: number,
  tier: 'regression' | 'capability' = 'regression',
): [string, CompareCaseMeta] {
  return [
    revisionId,
    {
      caseId: uuid(100 + caseNumber),
      title: `Case ${String(caseNumber)}`,
      scenario: 'happy-path',
      tier,
    },
  ];
}

const CASE_META = new Map<string, CompareCaseMeta>([
  meta(REV_STABLE, 1),
  meta(REV_FLIP_DOWN, 2),
  meta(REV_FLIP_UP, 3, 'capability'),
  // Edited: same caseId behind two revisions.
  [
    REV_EDITED_A,
    { caseId: uuid(104), title: 'Case 4', scenario: 'happy-path', tier: 'regression' },
  ],
  [
    REV_EDITED_B,
    { caseId: uuid(104), title: 'Case 4', scenario: 'happy-path', tier: 'regression' },
  ],
  meta(REV_REMOVED, 5),
  meta(REV_ADDED, 6),
  meta(REV_UNDECIDED, 7),
  meta(REV_CAPABILITY, 8, 'capability'),
]);

function trials(
  revisionId: string,
  verdicts: ReadonlyArray<'pass' | 'fail' | 'error' | null>,
  runPrefix: string,
): CompareTrialRow[] {
  return verdicts.map((verdict, i) => ({
    caseRevisionId: revisionId,
    trial: i + 1,
    disposition: verdict === null ? 'never_started' : 'graded',
    verdict,
    // Comparison reads the stored fold, not the deterministic verdict: a trial
    // whose judge rejected its quality claim is `behavior_fail` while `verdict`
    // stays `pass`.
    outcomeClass:
      verdict === null
        ? null
        : verdict === 'pass'
          ? 'behavior_pass'
          : verdict === 'fail'
            ? 'behavior_fail'
            : 'execution_error',
    runId: verdict === null ? null : `${runPrefix}-${revisionId.slice(-2)}-${String(i + 1)}`,
  }));
}

function buildFixture(): Parameters<typeof compareEvalBatches>[0] {
  return {
    batchA: BATCH_A,
    batchB: BATCH_B,
    memberRevisionIdsA: [
      REV_STABLE,
      REV_FLIP_DOWN,
      REV_FLIP_UP,
      REV_EDITED_A,
      REV_REMOVED,
      REV_UNDECIDED,
    ],
    memberRevisionIdsB: [
      REV_STABLE,
      REV_FLIP_DOWN,
      REV_FLIP_UP,
      REV_EDITED_B,
      REV_ADDED,
      REV_UNDECIDED,
    ],
    trialRowsA: [
      ...trials(REV_STABLE, ['pass', 'pass'], 'a'),
      ...trials(REV_FLIP_DOWN, ['pass', 'pass'], 'a'),
      ...trials(REV_FLIP_UP, ['fail', 'pass'], 'a'),
      ...trials(REV_EDITED_A, ['pass', 'pass'], 'a'),
      ...trials(REV_REMOVED, ['pass', 'pass'], 'a'),
      ...trials(REV_UNDECIDED, ['pass', 'pass'], 'a'),
    ],
    trialRowsB: [
      ...trials(REV_STABLE, ['pass', 'pass'], 'b'),
      ...trials(REV_FLIP_DOWN, ['pass', 'fail'], 'b'),
      ...trials(REV_FLIP_UP, ['pass', 'pass'], 'b'),
      ...trials(REV_EDITED_B, ['fail', 'fail'], 'b'),
      ...trials(REV_ADDED, ['pass', 'pass'], 'b'),
      // Undecided in B: one trial never started.
      ...trials(REV_UNDECIDED, ['pass', null], 'b'),
    ],
    caseMetaByRevisionId: CASE_META,
    rng: createSeededRng(42),
    resamples: 200,
  };
}

describe('compareEvalBatches — pairing and exclusion', () => {
  const comparison = compareEvalBatches(buildFixture());

  it('pairs ONLY identical, fully decided case revisions', () => {
    expect(comparison.pairedCases).toBe(3);
  });

  it('reports added/removed/edited/undecided explicitly — no silent drops', () => {
    expect(comparison.excluded.added.map((c) => c.caseRevisionId)).toEqual([REV_ADDED]);
    expect(comparison.excluded.removed.map((c) => c.caseRevisionId)).toEqual([REV_REMOVED]);
    expect(comparison.excluded.edited).toEqual([
      {
        caseId: uuid(104),
        caseRevisionIdA: REV_EDITED_A,
        caseRevisionIdB: REV_EDITED_B,
        caseTitle: 'Case 4',
      },
    ]);
    expect(comparison.excluded.undecided).toEqual([
      {
        caseId: uuid(107),
        caseRevisionId: REV_UNDECIDED,
        caseTitle: 'Case 7',
        decidedTrialsA: 2,
        decidedTrialsB: 1,
      },
    ]);
    expect(comparison.excluded.unresolvedRevisionIds).toEqual([]);
  });

  it('an edited case never enters the paired stats even though its trials graded on both sides', () => {
    const pairedRevisionsInFlips = comparison.flips.map((f) => f.caseRevisionId);
    expect(pairedRevisionsInFlips).not.toContain(REV_EDITED_A);
    expect(pairedRevisionsInFlips).not.toContain(REV_EDITED_B);
  });

  it('a member revision with no golden-case row is reported unresolved', () => {
    const fixture = buildFixture();
    const ghost = uuid(999);
    const withGhost = compareEvalBatches({
      ...fixture,
      memberRevisionIdsA: [...fixture.memberRevisionIdsA, ghost],
    });
    expect(withGhost.excluded.unresolvedRevisionIds).toEqual([ghost]);
    expect(withGhost.pairedCases).toBe(3);
  });
});

describe('compareEvalBatches — flips', () => {
  const comparison = compareEvalBatches(buildFixture());

  it('lists per-case success flips in both directions with trial runIds', () => {
    expect(comparison.flips).toHaveLength(2);
    const down = comparison.flips.find((f) => f.direction === 'pass_to_fail')!;
    expect(down.caseRevisionId).toBe(REV_FLIP_DOWN);
    expect(down.passedTrialsA).toBe(2);
    expect(down.passedTrialsB).toBe(1);
    expect(down.runIdsA).toHaveLength(2);
    expect(down.runIdsB).toHaveLength(2);
    expect(down.runIdsB[1]).toContain('b-');
    const up = comparison.flips.find((f) => f.direction === 'fail_to_pass')!;
    expect(up.caseRevisionId).toBe(REV_FLIP_UP);
  });

  it('regression-tier flips are INVESTIGATION findings; capability-tier flips inform', () => {
    const down = comparison.flips.find((f) => f.caseRevisionId === REV_FLIP_DOWN)!;
    expect(down.tier).toBe('regression');
    expect(down.finding).toBe('investigation');
    const up = comparison.flips.find((f) => f.caseRevisionId === REV_FLIP_UP)!;
    expect(up.tier).toBe('capability');
    expect(up.finding).toBe('informational');
  });
});

describe('compareEvalBatches — deltas and uncertainty', () => {
  it('computes pass^k / pass@k / trial-pass deltas over the paired set', () => {
    const comparison = compareEvalBatches(buildFixture());
    // Paired: STABLE (A ✓ B ✓), FLIP_DOWN (A ✓ B ✗), FLIP_UP (A ✗ B ✓).
    expect(comparison.perCaseSuccess!.rateA).toBeCloseTo(2 / 3, 10);
    expect(comparison.perCaseSuccess!.rateB).toBeCloseTo(2 / 3, 10);
    expect(comparison.perCaseSuccess!.delta).toBeCloseTo(0, 10);
    // pass@k: every paired case has at least one passing trial on both sides.
    expect(comparison.passAny!.rateA).toBeCloseTo(1, 10);
    expect(comparison.passAny!.rateB).toBeCloseTo(1, 10);
    // trial pass: A 5/6, B 5/6.
    expect(comparison.trialPass!.rateA).toBeCloseTo(5 / 6, 10);
    expect(comparison.trialPass!.rateB).toBeCloseTo(5 / 6, 10);
    expect(comparison.bootstrapResamples).toBe(200);
  });

  it('intervals are mandatory and the note states n — never a bare mean', () => {
    const comparison = compareEvalBatches(buildFixture());
    for (const delta of [comparison.perCaseSuccess!, comparison.passAny!, comparison.trialPass!]) {
      expect(delta.intervalLower).toBeLessThanOrEqual(delta.delta);
      expect(delta.intervalUpper).toBeGreaterThanOrEqual(delta.delta);
    }
    expect(comparison.uncertaintyNote).toContain('n=3');
    expect(comparison.uncertaintyNote).toContain('bootstrap interval');
    expect(comparison.uncertaintyNote).toContain('small');
  });

  it('the clustered bootstrap is deterministic under the same seed and moves under another', () => {
    const first = compareEvalBatches({ ...buildFixture(), rng: createSeededRng(42) });
    const second = compareEvalBatches({ ...buildFixture(), rng: createSeededRng(42) });
    const third = compareEvalBatches({ ...buildFixture(), rng: createSeededRng(7) });
    expect(first.perCaseSuccess).toEqual(second.perCaseSuccess);
    expect(first.trialPass).toEqual(second.trialPass);
    expect(
      first.perCaseSuccess!.intervalLower !== third.perCaseSuccess!.intervalLower ||
        first.perCaseSuccess!.intervalUpper !== third.perCaseSuccess!.intervalUpper,
    ).toBe(true);
  });

  it('omitting the injected rng still yields a deterministic (batch-id-seeded) result', () => {
    const fixture = buildFixture();
    delete (fixture as { rng?: unknown }).rng;
    const first = compareEvalBatches({ ...fixture });
    const second = compareEvalBatches({ ...fixture });
    expect(first).toEqual(second);
  });

  it('a real degradation reports a negative delta with an interval', () => {
    const memberIds = [REV_STABLE, REV_FLIP_DOWN, REV_FLIP_UP, REV_REMOVED, REV_UNDECIDED];
    const comparison = compareEvalBatches({
      batchA: BATCH_A,
      batchB: BATCH_B,
      memberRevisionIdsA: memberIds,
      memberRevisionIdsB: memberIds,
      trialRowsA: memberIds.flatMap((id) => trials(id, ['pass', 'pass'], 'a')),
      trialRowsB: memberIds.flatMap((id) => trials(id, ['fail', 'fail'], 'b')),
      caseMetaByRevisionId: CASE_META,
      rng: createSeededRng(1),
      resamples: 100,
    });
    expect(comparison.pairedCases).toBe(5);
    expect(comparison.perCaseSuccess!.delta).toBeCloseTo(-1, 10);
    // Every resample flips every case, so the interval excludes zero.
    expect(comparison.perCaseSuccess!.intervalUpper).toBeLessThan(0);
    expect(comparison.flips.every((f) => f.direction === 'pass_to_fail')).toBe(true);
  });
});

describe('compareEvalBatches — trials-per-case comparability', () => {
  it('same trials per case on both sides sets the flag true with no extra note', () => {
    const comparison = compareEvalBatches(buildFixture());
    expect(comparison.identicalTrialsPerCase).toBe(true);
    expect(comparison.uncertaintyNote).not.toContain('Trials per case differ');
  });

  it('differing trials per case is a machine-readable flag, not only prose', () => {
    const fixture = buildFixture();
    const comparison = compareEvalBatches({
      ...fixture,
      batchB: { ...BATCH_B, trialsPerCase: 3 },
      memberRevisionIdsB: [REV_STABLE],
      trialRowsB: trials(REV_STABLE, ['pass', 'pass', 'fail'], 'b'),
    });
    expect(comparison.identicalTrialsPerCase).toBe(false);
    // The paired mechanics still work — the flag qualifies, it does not refuse.
    expect(comparison.pairedCases).toBe(1);
    expect(comparison.uncertaintyNote).toContain('Trials per case differ (2 vs 3)');
    expect(comparison.uncertaintyNote).toContain('per-trial rate');
  });
});

describe('compareEvalBatches — degenerate shapes', () => {
  it('zero intersection: no deltas, no crash, everything reported as excluded', () => {
    const comparison = compareEvalBatches({
      batchA: BATCH_A,
      batchB: BATCH_B,
      memberRevisionIdsA: [REV_REMOVED],
      memberRevisionIdsB: [REV_ADDED],
      trialRowsA: trials(REV_REMOVED, ['pass', 'pass'], 'a'),
      trialRowsB: trials(REV_ADDED, ['pass', 'pass'], 'b'),
      caseMetaByRevisionId: CASE_META,
      rng: createSeededRng(1),
    });
    expect(comparison.pairedCases).toBe(0);
    expect(comparison.perCaseSuccess).toBeUndefined();
    expect(comparison.passAny).toBeUndefined();
    expect(comparison.trialPass).toBeUndefined();
    expect(comparison.bootstrapResamples).toBe(0);
    expect(comparison.flips).toEqual([]);
    expect(comparison.excluded.added).toHaveLength(1);
    expect(comparison.excluded.removed).toHaveLength(1);
    expect(comparison.uncertaintyNote).toContain('No paired cases');
  });

  it('cross-dataset-version comparison is intersection-only and says so', () => {
    const comparison = compareEvalBatches({
      ...buildFixture(),
      batchB: { ...BATCH_B, datasetVersion: 4 },
    });
    expect(comparison.identicalDatasetVersion).toBe(false);
    expect(comparison.uncertaintyNote).toContain('Dataset versions differ');
    expect(comparison.pairedCases).toBe(3);
  });

  it('default resample count is the named constant', () => {
    const fixture = buildFixture();
    delete (fixture as { resamples?: unknown }).resamples;
    const comparison = compareEvalBatches(fixture);
    expect(comparison.bootstrapResamples).toBe(COMPARISON_BOOTSTRAP_RESAMPLES);
  });
});

// ============================================================================
// Graduation flag (D12)
// ============================================================================

describe('deriveGraduationCandidates', () => {
  const capabilityRows = (batch: string): CompareTrialRow[] =>
    trials(REV_CAPABILITY, ['pass', 'pass'], batch);
  const regressionRows = (batch: string): CompareTrialRow[] =>
    trials(REV_STABLE, ['pass', 'pass'], batch);

  const snapshot = (n: number, rows: CompareTrialRow[]) => ({
    batchId: uuid(2000 + n),
    trialsPerCase: 2,
    trialRows: rows,
  });

  it('flags a capability case with full pass^k across the last N completed batches', () => {
    const candidates = deriveGraduationCandidates({
      completedBatchesNewestFirst: [
        snapshot(1, [...capabilityRows('b1'), ...regressionRows('b1')]),
        snapshot(2, [...capabilityRows('b2'), ...regressionRows('b2')]),
        snapshot(3, [...capabilityRows('b3'), ...regressionRows('b3')]),
      ],
      caseMetaByRevisionId: CASE_META,
      graduationConsecutiveBatches: 3,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      caseRevisionId: REV_CAPABILITY,
      scenario: 'happy-path',
      batchIds: [uuid(2001), uuid(2002), uuid(2003)],
    });
  });

  it('regression-tier cases never appear — graduation is a capability-only lifecycle', () => {
    const candidates = deriveGraduationCandidates({
      completedBatchesNewestFirst: [1, 2, 3].map((n) =>
        snapshot(n, regressionRows(`b${String(n)}`)),
      ),
      caseMetaByRevisionId: CASE_META,
      graduationConsecutiveBatches: 3,
    });
    expect(candidates).toEqual([]);
  });

  it('one failed trial anywhere in the window breaks the streak', () => {
    const candidates = deriveGraduationCandidates({
      completedBatchesNewestFirst: [
        snapshot(1, capabilityRows('b1')),
        snapshot(2, trials(REV_CAPABILITY, ['pass', 'fail'], 'b2')),
        snapshot(3, capabilityRows('b3')),
      ],
      caseMetaByRevisionId: CASE_META,
      graduationConsecutiveBatches: 3,
    });
    expect(candidates).toEqual([]);
  });

  it('a case absent from an older window batch (added later, or edited) has no streak yet', () => {
    const candidates = deriveGraduationCandidates({
      completedBatchesNewestFirst: [
        snapshot(1, capabilityRows('b1')),
        snapshot(2, capabilityRows('b2')),
        snapshot(3, regressionRows('b3')),
      ],
      caseMetaByRevisionId: CASE_META,
      graduationConsecutiveBatches: 3,
    });
    expect(candidates).toEqual([]);
  });

  it('fewer completed batches than the knob → no candidates (saturation needs history)', () => {
    const candidates = deriveGraduationCandidates({
      completedBatchesNewestFirst: [snapshot(1, capabilityRows('b1'))],
      caseMetaByRevisionId: CASE_META,
      graduationConsecutiveBatches: 3,
    });
    expect(candidates).toEqual([]);
  });
});
