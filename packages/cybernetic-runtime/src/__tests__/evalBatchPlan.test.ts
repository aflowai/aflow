/**
 * The eval-batch state machine's decision layer (Plan 269 D17): cost
 * preflight derives from real run history (no magic constants), claims
 * respect the skill-derived dispatch cap and the ceiling, terminalization
 * types never-started work, and the scorecard reports pass^k / pass@k —
 * never mean-of-trials — as reliability.
 */
import { describe, expect, it } from 'vitest';
import {
  computeBatchScorecard,
  computeCostPreflight,
  countDispositions,
  hasCrossedCostCeiling,
  isTerminalTrialDisposition,
  planBatchTerminalization,
  planTrialClaims,
  resolveBatchDispatchCap,
  type DispositionCounts,
  type ScorecardTrialRow,
} from '../evalBatchPlan.js';

describe('computeCostPreflight', () => {
  it('no cost history → no estimate, ceiling never pre-blocks', () => {
    const preflight = computeCostPreflight({
      recentRunCostsCents: [],
      caseCount: 10,
      trialsPerCase: 3,
      costCeilingCents: 100,
    });
    expect(preflight).toEqual({
      perRunMedianCents: null,
      sampleSize: 0,
      estimatedCostCents: null,
      exceedsCeiling: false,
    });
  });

  it('odd sample → middle value; estimate = median × cases × trials', () => {
    const preflight = computeCostPreflight({
      recentRunCostsCents: [50, 10, 30],
      caseCount: 4,
      trialsPerCase: 2,
      costCeilingCents: 1000,
    });
    expect(preflight.perRunMedianCents).toBe(30);
    expect(preflight.sampleSize).toBe(3);
    expect(preflight.estimatedCostCents).toBe(240);
    expect(preflight.exceedsCeiling).toBe(false);
  });

  it('even sample → rounded mean of middles; crossing the ceiling flags', () => {
    const preflight = computeCostPreflight({
      recentRunCostsCents: [10, 20, 31, 40],
      caseCount: 10,
      trialsPerCase: 1,
      costCeilingCents: 200,
    });
    expect(preflight.perRunMedianCents).toBe(26);
    expect(preflight.estimatedCostCents).toBe(260);
    expect(preflight.exceedsCeiling).toBe(true);
  });

  it('negative/NaN entries are dropped from the sample', () => {
    const preflight = computeCostPreflight({
      recentRunCostsCents: [Number.NaN, -5, 40],
      caseCount: 1,
      trialsPerCase: 1,
      costCeilingCents: 100,
    });
    expect(preflight.sampleSize).toBe(1);
    expect(preflight.perRunMedianCents).toBe(40);
  });
});

describe('resolveBatchDispatchCap + planTrialClaims', () => {
  it('undeclared policy gets the concurrency default, not serial execution', () => {
    // The public start path also falls back to 1, but that is a collision
    // guard against a skill running against itself. A batch is deliberate
    // parallel measurement and every non-live trial holds its own fixture
    // space, so the guard does not carry — falling back to 1 made a 24-trial
    // batch dispatch one at a time for no stated reason.
    expect(resolveBatchDispatchCap(undefined, 24)).toBe(5);
    expect(resolveBatchDispatchCap(undefined, 3)).toBe(3);
  });

  it('runs live-tier batches serially whatever the policy says', () => {
    // A live-tier trial runs in the batch's home space rather than a fixture
    // space, so concurrent trials would write into each other's world.
    expect(resolveBatchDispatchCap(10, 24, true)).toBe(1);
    expect(resolveBatchDispatchCap('unlimited', 24, true)).toBe(1);
  });

  it('a declared number is honored, clamped to the trial count', () => {
    expect(resolveBatchDispatchCap(5, 50)).toBe(5);
    expect(resolveBatchDispatchCap(5, 3)).toBe(3);
  });

  it('unlimited means only the trial count bounds dispatch', () => {
    expect(resolveBatchDispatchCap('unlimited', 42)).toBe(42);
  });

  it('claims fill the cap minus in-flight, bounded by claimable', () => {
    expect(
      planTrialClaims({
        batchStatus: 'running',
        dispatchCap: 4,
        runningCount: 1,
        claimableCount: 10,
        ceilingCrossed: false,
      }),
    ).toBe(3);
    expect(
      planTrialClaims({
        batchStatus: 'running',
        dispatchCap: 4,
        runningCount: 0,
        claimableCount: 2,
        ceilingCrossed: false,
      }),
    ).toBe(2);
  });

  it('a crossed ceiling or a non-running batch claims nothing', () => {
    expect(
      planTrialClaims({
        batchStatus: 'running',
        dispatchCap: 4,
        runningCount: 0,
        claimableCount: 10,
        ceilingCrossed: true,
      }),
    ).toBe(0);
    expect(
      planTrialClaims({
        batchStatus: 'cancelling',
        dispatchCap: 4,
        runningCount: 0,
        claimableCount: 10,
        ceilingCrossed: false,
      }),
    ).toBe(0);
  });

  it('ceiling is crossed at equality — spend equal to ceiling leaves no budget', () => {
    expect(hasCrossedCostCeiling(99, 100)).toBe(false);
    expect(hasCrossedCostCeiling(100, 100)).toBe(true);
  });
});

function counts(partial: Partial<DispositionCounts>): DispositionCounts {
  return {
    scheduled: 0,
    running: 0,
    graded: 0,
    infra_retry: 0,
    cancelled: 0,
    never_started: 0,
    ...partial,
  };
}

describe('planBatchTerminalization', () => {
  it('running with pending or in-flight work → keep going', () => {
    expect(
      planBatchTerminalization({
        status: 'running',
        counts: counts({ scheduled: 2, graded: 3 }),
        ceilingCrossed: false,
        costSpentCents: 10,
        costCeilingCents: 100,
      }),
    ).toBeNull();
    expect(
      planBatchTerminalization({
        status: 'running',
        counts: counts({ running: 1, graded: 4 }),
        ceilingCrossed: false,
        costSpentCents: 10,
        costCeilingCents: 100,
      }),
    ).toBeNull();
  });

  it('running fully drained → completed', () => {
    const plan = planBatchTerminalization({
      status: 'running',
      counts: counts({ graded: 5, cancelled: 1 }),
      ceilingCrossed: false,
      costSpentCents: 10,
      costCeilingCents: 100,
    });
    expect(plan).toEqual({ done: true, finalStatus: 'completed', markNeverStarted: false });
  });

  it('ceiling crossed: in-flight trials finish, pending rows get typed, batch fails', () => {
    const midFlight = planBatchTerminalization({
      status: 'running',
      counts: counts({ running: 2, scheduled: 3, graded: 1 }),
      ceilingCrossed: true,
      costSpentCents: 120,
      costCeilingCents: 100,
    });
    expect(midFlight?.done).toBe(false);
    expect(midFlight?.markNeverStarted).toBe(true);
    expect(midFlight?.finalStatus).toBe('failed');
    expect(midFlight?.terminalReason).toContain('COST_CEILING_EXCEEDED');

    const drained = planBatchTerminalization({
      status: 'running',
      counts: counts({ graded: 3, never_started: 3 }),
      ceilingCrossed: true,
      costSpentCents: 120,
      costCeilingCents: 100,
    });
    expect(drained?.done).toBe(true);
    expect(drained?.finalStatus).toBe('failed');
  });

  it('cancelling: waits for in-flight cancels, keeps graded rows, ends cancelled', () => {
    const midCancel = planBatchTerminalization({
      status: 'cancelling',
      counts: counts({ running: 1, graded: 2, never_started: 3 }),
      ceilingCrossed: false,
      costSpentCents: 10,
      costCeilingCents: 100,
    });
    expect(midCancel?.done).toBe(false);
    expect(midCancel?.finalStatus).toBe('cancelled');

    const drained = planBatchTerminalization({
      status: 'cancelling',
      counts: counts({ graded: 2, cancelled: 1, never_started: 3 }),
      ceilingCrossed: false,
      costSpentCents: 10,
      costCeilingCents: 100,
    });
    expect(drained?.done).toBe(true);
    expect(drained?.finalStatus).toBe('cancelled');
  });

  it('terminal batch statuses plan nothing', () => {
    expect(
      planBatchTerminalization({
        status: 'completed',
        counts: counts({ graded: 5 }),
        ceilingCrossed: false,
        costSpentCents: 10,
        costCeilingCents: 100,
      }),
    ).toBeNull();
  });
});

describe('countDispositions', () => {
  it('counts every disposition and reports terminality', () => {
    const tally = countDispositions([
      { disposition: 'graded' },
      { disposition: 'graded' },
      { disposition: 'running' },
      { disposition: 'infra_retry' },
      { disposition: 'never_started' },
    ]);
    expect(tally.graded).toBe(2);
    expect(tally.running).toBe(1);
    expect(tally.infra_retry).toBe(1);
    expect(tally.never_started).toBe(1);
    expect(isTerminalTrialDisposition('graded')).toBe(true);
    expect(isTerminalTrialDisposition('infra_retry')).toBe(false);
  });
});

// ============================================================================
// Scorecard
// ============================================================================

function gradedRow(
  caseRevisionId: string,
  trial: number,
  verdict: 'pass' | 'fail' | 'error',
  pendingRubrics: string[] = [],
  rubricResults: unknown[] = [],
): ScorecardTrialRow {
  return {
    caseRevisionId,
    trial,
    disposition: 'graded',
    verdict,
    // The writer always stores a class now; a fixture without one would test
    // the legacy path rather than the one production takes.
    outcomeClass:
      verdict === 'pass'
        ? 'behavior_pass'
        : verdict === 'fail'
          ? 'behavior_fail'
          : 'execution_error',
    resultsJson: {
      expectationResults: [],
      fractionPassed: verdict === 'pass' ? 1 : 0,
      fixtureTier: 'seeded',
      pendingRubrics,
      rubricResults,
    },
  };
}

function judgedRubric(criterionId: string, verdict: 'pass' | 'fail', judgeVersion = 'jv-1') {
  return {
    status: 'judged',
    criterionId,
    scopeKey: 'case_local',
    judgeVersion,
    rationale: 'Cited artifact.',
    verdict,
    score: verdict === 'pass' ? 1 : 0,
  };
}

describe('computeBatchScorecard', () => {
  const strata = new Map([
    ['case-a', { scenario: 'happy path', tier: 'regression' as const }],
    ['case-b', { scenario: 'happy path', tier: 'regression' as const }],
    ['case-c', { scenario: 'edge inputs', tier: 'capability' as const }],
  ]);

  it('pass^k needs ALL trials graded and passing; pass@k needs any pass', () => {
    const rows: ScorecardTrialRow[] = [
      gradedRow('case-a', 1, 'pass'),
      gradedRow('case-a', 2, 'pass'),
      gradedRow('case-b', 1, 'pass'),
      gradedRow('case-b', 2, 'fail'),
      gradedRow('case-c', 1, 'fail'),
      gradedRow('case-c', 2, 'fail'),
    ];
    const summary = computeBatchScorecard({
      rows,
      strataByCaseRevision: strata,
      trialsPerCase: 2,
      costSpentCents: 42,
    });
    expect(summary.cases).toBe(3);
    expect(summary.passRate).toBeCloseTo(3 / 6);
    expect(summary.passAllTrialsRate).toBeCloseTo(1 / 3);
    expect(summary.passAnyTrialRate).toBeCloseTo(2 / 3);
    expect(summary.costSpentCents).toBe(42);
    expect(summary.verdicts['pass']).toBe(3);
    expect(summary.verdicts['fail']).toBe(3);
  });

  it('a case with a never-started trial cannot claim pass^k', () => {
    const rows: ScorecardTrialRow[] = [
      gradedRow('case-a', 1, 'pass'),
      {
        caseRevisionId: 'case-a',
        trial: 2,
        disposition: 'never_started',
        verdict: null,
        resultsJson: null,
      },
    ];
    const summary = computeBatchScorecard({
      rows,
      strataByCaseRevision: strata,
      trialsPerCase: 2,
      costSpentCents: 0,
    });
    // The never-started trial is counted as evidence nobody can read, so a
    // truncated batch cannot read as a complete one.
    expect(summary.excludedTrials.incomplete_evidence).toBe(1);
    // No case carries a pass^k claim, which is not the same as 0% passing:
    // reporting a rate here would say the design failed when nothing was
    // measured. The shortfall is visible in scoredTrials against trialsPerCase.
    expect(summary.passAllTrialsRate).toBeUndefined();
    expect(summary.scoredTrials).toBe(1);
    expect(summary.passAnyTrialRate).toBe(1);
    expect(summary.dispositions['never_started']).toBe(1);
  });

  it('strata group per (scenario, tier) with their own rates', () => {
    const rows: ScorecardTrialRow[] = [
      gradedRow('case-a', 1, 'pass'),
      gradedRow('case-b', 1, 'fail'),
      gradedRow('case-c', 1, 'pass'),
    ];
    const summary = computeBatchScorecard({
      rows,
      strataByCaseRevision: strata,
      trialsPerCase: 1,
      costSpentCents: 0,
    });
    expect(summary.strata).toHaveLength(2);
    const regression = summary.strata.find((s) => s.tier === 'regression');
    expect(regression?.cases).toBe(2);
    expect(regression?.passRate).toBeCloseTo(0.5);
    const capability = summary.strata.find((s) => s.tier === 'capability');
    expect(capability?.passRate).toBe(1);
  });

  it('counts trials whose spend was never recorded, so 0¢ is not read as free', () => {
    const observed = gradedRow('case-a', 1, 'pass');
    const unobserved = gradedRow('case-b', 1, 'pass');
    (unobserved.resultsJson as Record<string, unknown>)['costObserved'] = false;

    const summary = computeBatchScorecard({
      rows: [observed, unobserved],
      strataByCaseRevision: strata,
      trialsPerCase: 1,
      costSpentCents: 0,
    });

    // Both trials contributed 0¢, but only one of them actually cost nothing.
    expect(summary.costSpentCents).toBe(0);
    expect(summary.costUnobservedTrials).toBe(1);
  });

  it('zeroJudgeShare = graded trials with no pending rubric slots AND no judge calls', () => {
    const rows: ScorecardTrialRow[] = [
      gradedRow('case-a', 1, 'pass'),
      gradedRow('case-b', 1, 'pass', ['clarity']),
      gradedRow('case-c', 1, 'pass', [], [judgedRubric('clarity', 'pass')]),
    ];
    const summary = computeBatchScorecard({
      rows,
      strataByCaseRevision: strata,
      trialsPerCase: 1,
      costSpentCents: 0,
    });
    expect(summary.zeroJudgeShare).toBeCloseTo(1 / 3);
  });

  it('a trial whose judges were all skipped/sampled-out still counts zero-judge', () => {
    const rows: ScorecardTrialRow[] = [
      gradedRow(
        'case-a',
        1,
        'fail',
        [],
        [{ status: 'skipped_run_error', criterionId: 'clarity', scopeKey: 'case_local' }],
      ),
      gradedRow(
        'case-b',
        1,
        'pass',
        [],
        [{ status: 'not_selected', criterionId: 'clarity', scopeKey: 'case_local' }],
      ),
    ];
    const summary = computeBatchScorecard({
      rows,
      strataByCaseRevision: strata,
      trialsPerCase: 1,
      costSpentCents: 0,
    });
    expect(summary.zeroJudgeShare).toBe(1);
  });

  it('advisory judge section aggregates per criterion and NEVER moves the deterministic pass metrics', () => {
    const rows: ScorecardTrialRow[] = [
      // Deterministically passing trials whose judge FAILS them.
      gradedRow('case-a', 1, 'pass', [], [judgedRubric('clarity', 'fail')]),
      gradedRow('case-b', 1, 'pass', [], [judgedRubric('clarity', 'pass')]),
      // A run that errored → nothing to judge.
      gradedRow(
        'case-c',
        1,
        'error',
        [],
        [{ status: 'skipped_run_error', criterionId: 'clarity', scopeKey: 'case_local' }],
      ),
    ];
    const summary = computeBatchScorecard({
      rows,
      strataByCaseRevision: strata,
      trialsPerCase: 1,
      costSpentCents: 0,
    });

    // Deterministic metrics reflect ONLY the deterministic verdicts, and only
    // the trials that carried a behavioural claim. The errored run is not a
    // third of a failure — it is excluded and counted as an execution failure,
    // so the score reads 2/2 with the exclusion visible beside it.
    expect(summary.passRate).toBe(1);
    expect(summary.scoredTrials).toBe(2);
    expect(summary.excludedTrials.execution_error).toBe(1);
    expect(summary.executionFailureRate).toBeCloseTo(1 / 3);
    expect(summary.verdicts['pass']).toBe(2);

    expect(summary.advisoryJudgeCriteria).toHaveLength(1);
    const clarity = summary.advisoryJudgeCriteria[0]!;
    expect(clarity.criterionId).toBe('clarity');
    expect(clarity.scopeKey).toBe('case_local');
    expect(clarity.judgeVersion).toBe('jv-1');
    expect(clarity.judgedTrials).toBe(2);
    expect(clarity.passedTrials).toBe(1);
    expect(clarity.passShare).toBeCloseTo(0.5);
    expect(clarity.skippedDeterministicFailTrials).toBe(1);
    expect(clarity.errorTrials).toBe(0);
    expect(clarity.notSelectedTrials).toBe(0);
  });

  it('mixed judge versions on one criterion omit the version; errors are tallied', () => {
    const rows: ScorecardTrialRow[] = [
      gradedRow('case-a', 1, 'pass', [], [judgedRubric('clarity', 'pass', 'jv-1')]),
      gradedRow('case-b', 1, 'pass', [], [judgedRubric('clarity', 'pass', 'jv-2')]),
      gradedRow(
        'case-c',
        1,
        'pass',
        [],
        [
          {
            status: 'error',
            criterionId: 'clarity',
            scopeKey: 'case_local',
            errorCode: 'judge_dispatch_failed',
            errorMessage: 'provider down',
          },
        ],
      ),
    ];
    const summary = computeBatchScorecard({
      rows,
      strataByCaseRevision: strata,
      trialsPerCase: 1,
      costSpentCents: 0,
    });
    const clarity = summary.advisoryJudgeCriteria[0]!;
    expect(clarity.judgeVersion).toBeUndefined();
    expect(clarity.judgedTrials).toBe(2);
    expect(clarity.errorTrials).toBe(1);
  });

  it('a terminal reason is carried into the summary', () => {
    const summary = computeBatchScorecard({
      rows: [gradedRow('case-a', 1, 'pass')],
      strataByCaseRevision: strata,
      trialsPerCase: 1,
      costSpentCents: 150,
      terminalReason: 'COST_CEILING_EXCEEDED: spent 150¢ of the 100¢ ceiling',
    });
    expect(summary.terminalReason).toContain('COST_CEILING_EXCEEDED');
  });
});
