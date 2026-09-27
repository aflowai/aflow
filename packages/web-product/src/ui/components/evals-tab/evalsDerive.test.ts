import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  EvalBatchCaseResultView,
  EvalLabelQueueEvidence,
  EvalTrialCallView,
  EvalTrialDetailView,
  ExpectationResult,
  GoldenCaseContent,
  GoldenCaseRevision,
} from '@aflow/schemas';
import { EvalTrialDetailViewSchema } from '@aflow/schemas';
import type { LabelQueueItem } from './evalsApi.js';
import type { JudgeEvidenceBlock } from './evalsDerive.js';

import {
  countFailingTrials,
  deriveCaseReview,
  deriveCaseRollup,
  deriveCoverage,
  deriveEvidenceRender,
  deriveItemReadability,
  deriveQueuePosition,
  deriveReviewQueue,
  deriveSubmitFailure,
  deriveSubmitGate,
  deriveJudgeEvidenceView,
  deriveRubricQuestionView,
  deriveSiblingTrials,
  deriveTrialAttribution,
  deriveTrialChecks,
  deriveTrialReplyState,
  deriveTrialRubricGroups,
  deriveTrialTally,
  deriveTrialTrajectoryFacts,
  EXPECTATION_KIND_LABEL,
  formatBatchSize,
  formatCents,
  formatComparisonSubtitle,
  formatDeltaCompact,
  formatDeltaWithInterval,
  formatEvidencePreview,
  formatJudgeSummary,
  formatPct,
  formatSiblingSummary,
  formatTrialsSubtitle,
  formatTrialTally,
  groupCasesByScenario,
  intervalExcludesZero,
  readApiErrorCode,
  summariseUnreadable,
} from './evalsDerive.js';

function revision(
  title: string,
  scenario: string,
  tier: 'regression' | 'capability',
  direction: 'should_succeed' | 'should_pause' | 'should_block',
): GoldenCaseRevision {
  return {
    revisionId: '00000000-0000-0000-0000-000000000001',
    caseId: '00000000-0000-0000-0000-000000000002',
    datasetId: '00000000-0000-0000-0000-000000000003',
    addedInVersion: 1,
    status: 'active',
    case: {
      caseId: '00000000-0000-0000-0000-000000000002',
      datasetId: '00000000-0000-0000-0000-000000000003',
      title,
      stratum: { scenario, tier, direction },
      trigger: { inputs: {} },
      fixture: { tier: 'live', learnings: 'none' },
      requirements: [],
      expectations: [],
      rubrics: [],
      provenance: { source: 'curated', workflowRevision: 1 },
    },
  } as GoldenCaseRevision;
}

describe('groupCasesByScenario', () => {
  it('groups by stratum scenario, scenarios and titles sorted', () => {
    const groups = groupCasesByScenario([
      revision('Zeta', 'timeouts', 'regression', 'should_succeed'),
      revision('Alpha', 'timeouts', 'capability', 'should_succeed'),
      revision('Solo', 'auth-failures', 'regression', 'should_block'),
    ]);
    expect(groups.map((g) => g.scenario)).toEqual(['auth-failures', 'timeouts']);
    expect(groups[1]!.cases.map((c) => c.case.title)).toEqual(['Alpha', 'Zeta']);
  });

  it('returns empty for an empty case set', () => {
    expect(groupCasesByScenario([])).toEqual([]);
  });
});

describe('deriveCoverage', () => {
  it('reports a cell a shared scenario leaves empty while another occupies it', () => {
    const coverage = deriveCoverage([
      revision('A', 'timeouts', 'regression', 'should_succeed'),
      revision('B', 'timeouts', 'regression', 'should_succeed'),
      revision('C', 'auth-failures', 'regression', 'should_succeed'),
      revision('D', 'auth-failures', 'capability', 'should_succeed'),
    ]);
    expect(coverage.gaps).toEqual([
      { scenario: 'timeouts', tier: 'capability', direction: 'should_succeed' },
    ]);
    expect(coverage.singletonScenarios).toBe(0);
  });

  it('claims no gap against a scenario carrying one case, and says how many there are', () => {
    // The dataset never said a lone scenario should span directions. Saying it
    // anyway turned one real gap into twelve warnings on a live dataset.
    const coverage = deriveCoverage([
      revision('A', 'timeouts', 'regression', 'should_succeed'),
      revision('B', 'timeouts', 'capability', 'should_succeed'),
      revision('C', 'auth-failures', 'regression', 'should_succeed'),
      revision('D', 'A whole sentence describing one case', 'capability', 'should_succeed'),
    ]);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.singletonScenarios).toBe(2);
  });

  it('reports nothing when every bucket covers every observed combination', () => {
    const coverage = deriveCoverage([
      revision('A', 'timeouts', 'regression', 'should_succeed'),
      revision('B', 'timeouts', 'regression', 'should_pause'),
    ]);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.singletonScenarios).toBe(0);
  });

  it('derives the combination surface from the data, never a fixed taxonomy', () => {
    // One case: one scenario × one combo — zero gaps, not 5 invented cells
    // from the full tier × direction cross product.
    const coverage = deriveCoverage([revision('A', 'timeouts', 'capability', 'should_block')]);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.singletonScenarios).toBe(1);
  });

  it('is empty for an empty dataset', () => {
    expect(deriveCoverage([])).toEqual({ gaps: [], singletonScenarios: 0 });
  });
});

describe('formatting', () => {
  it('formats cents below a dollar as cents, above as dollars', () => {
    expect(formatCents(45)).toBe('45¢');
    expect(formatCents(1250)).toBe('$12.50');
  });

  it('formats fractions as percentages', () => {
    expect(formatPct(0.625)).toBe('62.5%');
  });

  it('renders a delta with both rates and its interval — never bare', () => {
    const text = formatDeltaWithInterval({
      rateA: 0.62,
      rateB: 0.71,
      delta: 0.09,
      intervalLower: 0.012,
      intervalUpper: 0.168,
    });
    expect(text).toBe('62.0% → 71.0% (Δ +9.0pp, 95% CI [+1.2pp, +16.8pp])');
  });

  it('reads the interval as evidence around zero', () => {
    expect(
      intervalExcludesZero({
        rateA: 0.9,
        rateB: 0.6,
        delta: -0.3,
        intervalLower: -0.5,
        intervalUpper: -0.1,
      }),
    ).toBe(true);
    expect(
      intervalExcludesZero({
        rateA: 0.9,
        rateB: 0.88,
        delta: -0.02,
        intervalLower: -0.2,
        intervalUpper: 0.15,
      }),
    ).toBe(false);
  });
});

describe('label queue — the question and the material', () => {
  it('renders the rubric as the criterion name plus each entry', () => {
    const view = deriveRubricQuestionView({
      criterionId: 'faithfulness',
      rubric: {
        criterionId: 'faithfulness',
        scopeKey: 'case_local',
        name: 'faithfulness',
        entries: [
          { criterion: 'No fabricated numbers', scale: 'binary', description: 'Figures cited.' },
        ],
        referenceAnswer: 'Revenue was 4.2M.',
      },
    });
    expect(view.title).toBe('faithfulness');
    expect(view.entries).toHaveLength(1);
    expect(view.referenceAnswer).toBe('Revenue was 4.2M.');
    expect(view.note).toBeNull();
  });

  it('an unresolved rubric says why instead of showing an empty question', () => {
    const view = deriveRubricQuestionView({
      criterionId: 'clarity',
      rubric: {
        criterionId: 'clarity',
        scopeKey: 'suite',
        entries: [],
        unresolved: 'No production eval suite exists.',
      },
    });
    expect(view.title).toBe('clarity');
    expect(view.entries).toEqual([]);
    expect(view.note).toBe('No production eval suite exists.');
  });

  it('a missing rubric still names the criterion and flags that PASS is unstated', () => {
    const view = deriveRubricQuestionView({ criterionId: 'clarity' });
    expect(view.title).toBe('clarity');
    expect(view.note).not.toBeNull();
  });

  it('orders the judge’s evidence as the judge’s own prompt orders it', () => {
    const view = deriveJudgeEvidenceView({
      status: 'available',
      taskSummaries: [{ taskId: 'write', status: 'completed', summary: 'Wrote it.' }],
      taskOutputs: [{ taskId: 'write', content: '{"summary":"ok"}' }],
      referenceOutput: 'Revenue was 4.2M.',
      unresolvedArtifacts: 0,
    });
    expect(view.blocks.map((block) => block.label)).toEqual([
      'Reference output (guidance — similarity is never scored)',
      'Run artifacts',
      'Task output — write',
    ]);
    expect(view.blocks[1]?.content).toBe('write [COMPLETED]: Wrote it.');
    expect(view.note).toBeNull();
  });

  it('unavailable evidence surfaces its typed detail, never a blank panel', () => {
    const view = deriveJudgeEvidenceView({
      status: 'unavailable',
      reason: 'run_reaped',
      detail: "Trial run 'run-7' is gone — its fixture space was reaped.",
    });
    expect(view.blocks).toEqual([]);
    expect(view.note).toBe("Trial run 'run-7' is gone — its fixture space was reaped.");
  });

  it('an available-but-empty evidence pack says so rather than reading as silence', () => {
    const view = deriveJudgeEvidenceView({
      status: 'available',
      taskSummaries: [],
      taskOutputs: [],
      unresolvedArtifacts: 0,
    });
    expect(view.blocks).toEqual([]);
    expect(view.note).toContain('no task outputs');
  });

  it('an item listed without evidence says the evidence is missing, not that the run was', () => {
    expect(deriveJudgeEvidenceView(undefined).note).toContain('not included');
  });

  it('warns when the pack is narrower than the judge’s — silence would read as parity', () => {
    const view = deriveJudgeEvidenceView({
      status: 'available',
      taskSummaries: [{ taskId: 'write', status: 'completed', summary: 'Wrote it.' }],
      taskOutputs: [],
      unresolvedArtifacts: 2,
    });
    // The summaries block keeps `blocks` non-empty, so only the warning shows the gap.
    expect(view.blocks).toHaveLength(1);
    expect(view.note).toBeNull();
    expect(view.warning).toContain('2 artifacts');
  });

  it('a rubric edited since grading is flagged as a different question', () => {
    const view = deriveRubricQuestionView({
      criterionId: 'clarity',
      rubric: {
        criterionId: 'clarity',
        scopeKey: 'suite',
        name: 'clarity',
        entries: [{ criterion: 'Reads clearly', scale: 'binary', description: 'Edited.' }],
        judgeVersionDrift: 'The production suite’s ‘clarity’ no longer matches.',
      },
    });
    expect(view.note).toBeNull();
    expect(view.warning).toContain('no longer matches');
  });
});

// ============================================================================
// Per-trial attribution
// ============================================================================

function trialDetail(overrides: Partial<EvalTrialDetailView> = {}): EvalTrialDetailView {
  return EvalTrialDetailViewSchema.parse({
    batchId: '00000000-0000-0000-0000-0000000000b1',
    caseRevisionId: '00000000-0000-0000-0000-0000000000c1',
    trial: 1,
    disposition: 'graded',
    verdict: 'fail',
    runId: 'run-1',
    runStatus: 'completed',
    fractionPassed: 0.5,
    ...overrides,
  });
}

function check(
  expectationIndex: number,
  kind: ExpectationResult['kind'],
  passed: boolean,
  detail?: string,
): ExpectationResult {
  return { expectationIndex, kind, passed, ...(detail !== undefined ? { detail } : {}) };
}

function call(
  sequence: number,
  endpointId: string,
  responseStatus: number,
  extra: { simulationId?: string; mutated?: boolean } = {},
): EvalTrialCallView {
  return {
    sequence,
    endpointId,
    responseStatus,
    simulationId: extra.simulationId ?? 'sim-a',
    mutated: extra.mutated ?? false,
  };
}

function judged(criterionId: string, verdict: 'pass' | 'fail', rationale = 'because') {
  return {
    status: 'judged' as const,
    criterionId,
    scopeKey: 'suite',
    judgeVersion: 'jv-1',
    rationale,
    verdict,
    score: verdict === 'pass' ? 1 : 0,
  };
}

describe('deriveTrialChecks', () => {
  it('partitions every schema kind into exactly one exit group', () => {
    const kinds = Object.keys(EXPECTATION_KIND_LABEL) as Array<ExpectationResult['kind']>;
    const checks = deriveTrialChecks(
      trialDetail({
        expectationResults: kinds.map((kind, i) => check(i, kind, false)),
        fractionPassed: 0,
      }),
    );
    expect(checks.total).toBe(kinds.length);
    expect(checks.contract.total + checks.instruction.total).toBe(kinds.length);
    for (const kind of kinds) {
      const inContract = checks.contract.failing.some((r) => r.kind === kind);
      const inInstruction = checks.instruction.failing.some((r) => r.kind === kind);
      expect(inContract !== inInstruction).toBe(true);
    }
  });

  it('preserves the authored order within each group', () => {
    const checks = deriveTrialChecks(
      trialDetail({
        expectationResults: [
          check(3, 'trajectory', false),
          check(0, 'reply', false),
          check(1, 'simulation', false),
        ],
        fractionPassed: 0,
      }),
    );
    expect(checks.contract.failing.map((r) => r.expectationIndex)).toEqual([3, 1]);
    expect(checks.instruction.failing.map((r) => r.expectationIndex)).toEqual([0]);
  });

  it('flags a recorded fraction that disagrees with the listed checks', () => {
    const checks = deriveTrialChecks(
      trialDetail({
        expectationResults: [check(0, 'reply', true), check(1, 'reply', false)],
        fractionPassed: 0.9,
      }),
    );
    expect(checks.fractionMismatch).toContain('90.0%');
    expect(checks.fractionMismatch).toContain('50.0%');
  });

  it('stays silent inside half a point', () => {
    const checks = deriveTrialChecks(
      trialDetail({
        expectationResults: [check(0, 'reply', true), check(1, 'reply', false)],
        fractionPassed: 0.502,
      }),
    );
    expect(checks.fractionMismatch).toBeNull();
  });
});

describe('deriveTrialTrajectoryFacts', () => {
  it('takes the first refusal in ARRAY order, not the lowest sequence', () => {
    const facts = deriveTrialTrajectoryFacts(
      trialDetail({
        trajectory: [call(7, 'later-endpoint', 500), call(2, 'earlier-endpoint', 403)],
      }),
    );
    expect(facts.firstRefused?.endpointId).toBe('later-endpoint');
    expect(facts.refused).toBe(2);
  });

  it('counts mutating calls and reports a single simulation as the sole one', () => {
    const facts = deriveTrialTrajectoryFacts(
      trialDetail({
        trajectory: [call(0, 'a', 200, { mutated: true }), call(1, 'b', 200)],
      }),
    );
    expect(facts.calls).toBe(2);
    expect(facts.mutating).toBe(1);
    expect(facts.multiSimulation).toBe(false);
    expect(facts.soleSimulationId).toBe('sim-a');
  });

  it('multiSimulation and soleSimulationId are mutually exclusive', () => {
    const facts = deriveTrialTrajectoryFacts(
      trialDetail({
        trajectory: [call(0, 'a', 200), call(1, 'b', 200, { simulationId: 'sim-b' })],
      }),
    );
    expect(facts.multiSimulation).toBe(true);
    expect(facts.soleSimulationId).toBeNull();
  });

  it('an empty trajectory reports no calls and no sole simulation', () => {
    const facts = deriveTrialTrajectoryFacts(trialDetail({ trajectory: [] }));
    expect(facts.calls).toBe(0);
    expect(facts.firstRefused).toBeNull();
    expect(facts.soleSimulationId).toBeNull();
  });
});

describe('deriveTrialReplyState', () => {
  it('a resolved reply is text', () => {
    expect(deriveTrialReplyState(trialDetail({ reply: 'The amount is 200.' }))).toEqual({
      state: 'text',
      text: 'The amount is 200.',
    });
  });

  it('a ref with no resolved reply is unresolved — never silence', () => {
    const state = deriveTrialReplyState(trialDetail({ replyRef: 'inline:abc' }));
    expect(state).toEqual({ state: 'unresolved', ref: 'inline:abc' });
    expect(state.state).not.toBe('none');
  });

  it('no ref at all means the run produced no reply artifact', () => {
    expect(deriveTrialReplyState(trialDetail())).toEqual({ state: 'none' });
  });

  it('no run is distinct from a run that produced nothing', () => {
    const detail = trialDetail();
    const noRun = { ...detail } as EvalTrialDetailView;
    delete (noRun as { runId?: string }).runId;
    expect(deriveTrialReplyState(noRun)).toEqual({ state: 'no_run' });
  });
});

describe('deriveTrialRubricGroups', () => {
  it('partitions the four statuses disjointly', () => {
    const groups = deriveTrialRubricGroups(
      trialDetail({
        rubricResults: [
          judged('a', 'pass'),
          {
            status: 'error',
            criterionId: 'b',
            scopeKey: 'suite',
            errorCode: 'judge_dispatch_failed',
            errorMessage: 'timeout',
          },
          { status: 'not_selected', criterionId: 'c', scopeKey: 'suite' },
          { status: 'skipped_run_error', criterionId: 'd', scopeKey: 'suite' },
        ],
      }),
    );
    expect(groups.judged).toHaveLength(1);
    expect(groups.errors).toHaveLength(1);
    expect(groups.notSelected).toHaveLength(1);
    expect(groups.skipped).toHaveLength(1);
  });

  it('keeps never-resolved slots on their own axis, never merged with judged rows', () => {
    const groups = deriveTrialRubricGroups(
      trialDetail({ rubricResults: [], pendingRubrics: ['suite:clarity', 'suite:accuracy'] }),
    );
    expect(groups.judged).toEqual([]);
    expect(groups.pending).toEqual(['suite:clarity', 'suite:accuracy']);
    expect(groups.disagree).toBe(0);
  });

  it('disagree is null when there is no verdict to compare', () => {
    const detail = trialDetail({ verdict: 'error', gradingError: 'grader blew up' });
    expect(deriveTrialRubricGroups(detail).disagree).toBeNull();
  });

  it('allJudgedPass needs a non-empty judged set and a fail verdict', () => {
    expect(
      deriveTrialRubricGroups(trialDetail({ rubricResults: [], pendingRubrics: ['x'] }))
        .allJudgedPass,
    ).toBe(false);
    expect(
      deriveTrialRubricGroups(
        trialDetail({ verdict: 'pass', rubricResults: [judged('a', 'pass')] }),
      ).allJudgedPass,
    ).toBe(false);
    expect(
      deriveTrialRubricGroups(trialDetail({ rubricResults: [judged('a', 'pass')] })).allJudgedPass,
    ).toBe(true);
    expect(
      deriveTrialRubricGroups(
        trialDetail({ rubricResults: [judged('a', 'pass'), judged('b', 'fail')] }),
      ).allJudgedPass,
    ).toBe(false);
  });
});

describe('formatJudgeSummary', () => {
  const groupsFor = (detail: EvalTrialDetailView) => deriveTrialRubricGroups(detail);

  it('says so when the suite carries no rubrics at all', () => {
    const detail = trialDetail();
    expect(formatJudgeSummary(groupsFor(detail), false)).toBe('no rubrics on this suite');
  });

  it('never reports "0 disagree" when the judges never resolved', () => {
    const detail = trialDetail({ pendingRubrics: ['suite:clarity'] });
    const text = formatJudgeSummary(groupsFor(detail), true);
    expect(text).toBe('not assessable — judges unresolved');
    expect(text).not.toContain('disagree');
  });

  it('distinguishes no judge returning a verdict from judges never running', () => {
    const detail = trialDetail({
      rubricResults: [{ status: 'not_selected', criterionId: 'a', scopeKey: 'suite' }],
    });
    expect(formatJudgeSummary(groupsFor(detail), true)).toBe(
      'not assessable — no judge returned a verdict',
    );
  });

  it('reports the disagreement count against a decided verdict', () => {
    const detail = trialDetail({
      rubricResults: [
        {
          status: 'judged',
          criterionId: 'a',
          scopeKey: 'suite',
          judgeVersion: 'jv-1',
          rationale: '',
          verdict: 'pass',
          score: 1,
        },
      ],
    });
    expect(formatJudgeSummary(groupsFor(detail), true)).toBe('1 judged, 1 disagree');
  });

  it('withholds a count when the trial verdict cannot be compared', () => {
    const detail = trialDetail({
      verdict: 'error',
      gradingError: 'grader blew up',
      rubricResults: [
        {
          status: 'judged',
          criterionId: 'a',
          scopeKey: 'suite',
          judgeVersion: 'jv-1',
          rationale: '',
          verdict: 'pass',
          score: 1,
        },
      ],
    });
    expect(formatJudgeSummary(groupsFor(detail), true)).toBe('1 judged — no verdict to compare');
  });
});

describe('deriveTrialAttribution', () => {
  it('every non-graded disposition gets its own sentence', () => {
    const sentences = new Set<string>();
    for (const disposition of [
      'scheduled',
      'running',
      'infra_retry',
      'cancelled',
      'never_started',
    ] as const) {
      const attribution = deriveTrialAttribution(
        trialDetail({ disposition, verdict: undefined, fractionPassed: undefined }),
      );
      expect(attribution.status).toBe('not_graded');
      expect(attribution.confident).toBe(false);
      expect(attribution.exits).toEqual([]);
      sentences.add(attribution.basis[0] ?? '');
    }
    expect(sentences.size).toBe(5);
  });

  it('graded with no verdict says exactly that', () => {
    const attribution = deriveTrialAttribution(trialDetail({ verdict: undefined }));
    expect(attribution.status).toBe('not_graded');
    expect(attribution.basis[0]).toBe('The trial is marked graded but carries no verdict.');
  });

  it('an unparsed result record suppresses the exit cards and names no exit', () => {
    const attribution = deriveTrialAttribution(trialDetail({ resultsReadable: false }));
    expect(attribution.status).toBe('results_unreadable');
    expect(attribution.suppressExitCards).toBe(true);
    expect(attribution.exits).toEqual([]);
    expect(attribution.basis.join(' ')).toContain('not because nothing fired');
  });

  it('a judge-only case is read, not mistaken for an unparsed record', () => {
    const attribution = deriveTrialAttribution(
      trialDetail({
        fractionPassed: undefined,
        expectationResults: [],
        rubricResults: [judged('tone', 'fail', 'The reply blamed the customer.')],
        trajectory: [call(0, 'GET /tickets', 200)],
      }),
    );
    expect(attribution.status).not.toBe('results_unreadable');
    expect(attribution.basis.join(' ')).toContain('The reply blamed the customer.');
  });

  it('a conversational trial that reached no endpoint still names its failing judge', () => {
    // A rubric-only case answers without tools, so "the run reached no
    // endpoint" is its normal shape — reading that as the cause buried the
    // judge that actually decided the trial.
    const attribution = deriveTrialAttribution(
      trialDetail({
        fractionPassed: undefined,
        expectationResults: [],
        rubricResults: [judged('tone', 'fail', 'The reply blamed the customer.')],
        trajectory: [],
      }),
    );
    expect(attribution.headline).toBe('Two possible causes: the answer, or the rubric');
    expect(attribution.basis[0]).toContain('The reply blamed the customer.');
  });

  it('a judge is a cause: a fail no check explains names the answer and the rubric', () => {
    const attribution = deriveTrialAttribution(
      trialDetail({
        fractionPassed: 1,
        expectationResults: [check(0, 'output', true)],
        rubricResults: [judged('tone', 'fail', 'The reply blamed the customer.')],
        trajectory: [call(0, 'GET /tickets', 200)],
      }),
    );
    expect(attribution.status).toBe('contested');
    expect(attribution.headline).toBe('Two possible causes: the answer, or the rubric');
    expect(attribution.exits).toEqual(['instruction', 'expectation']);
    expect(attribution.basis[0]).toContain('The judge failed tone');
    expect(attribution.basis[0]).toContain('The reply blamed the customer.');
  });

  it('a trial with no run is not an attribution', () => {
    const detail = trialDetail();
    delete (detail as { runId?: string }).runId;
    const attribution = deriveTrialAttribution(detail);
    expect(attribution.status).toBe('no_run');
    expect(attribution.confident).toBe(false);
  });

  it('a failed run reports the run, not an exit', () => {
    const attribution = deriveTrialAttribution(
      trialDetail({ runStatus: 'failed', expectationResults: [check(0, 'reply', false)] }),
    );
    expect(attribution.status).toBe('run_incomplete');
    expect(attribution.headline).toBe('Run failed');
    expect(attribution.exits).toEqual([]);
  });

  it('a graded trial is not explained by the cleanup that cancelled its run', () => {
    // The harness cancels a trial's run once its pause is read and graded, so
    // naming the cancellation would report "no answer was produced" beside the
    // checks that just read one.
    const attribution = deriveTrialAttribution(
      trialDetail({
        runStatus: 'cancelled',
        fractionPassed: 0,
        expectationResults: [check(0, 'output', false, 'never asked which order')],
        trajectory: [call(0, 'GET /orders', 200)],
      }),
    );
    expect(attribution.status).not.toBe('run_incomplete');
    expect(attribution.basis.join(' ')).not.toContain('no answer was produced');
  });

  it('a cancelled run names the cancellation', () => {
    expect(deriveTrialAttribution(trialDetail({ runStatus: 'cancelled' })).headline).toBe(
      'Run cancelled',
    );
  });

  it('a grader fault is not an attribution and carries its reason', () => {
    const attribution = deriveTrialAttribution(
      trialDetail({ verdict: 'error', gradingError: 'expression threw' }),
    );
    expect(attribution.status).toBe('grader_fault');
    expect(attribution.basis).toContain('expression threw');
  });

  it('a pass names no exit', () => {
    const attribution = deriveTrialAttribution(
      trialDetail({ verdict: 'pass', fractionPassed: 1, trajectory: [call(0, 'a', 200)] }),
    );
    expect(attribution.status).toBe('passed');
    expect(attribution.confident).toBe(true);
    expect(attribution.basis).toEqual([]);
  });

  it('a pass that reached no endpoint says so', () => {
    const attribution = deriveTrialAttribution(trialDetail({ verdict: 'pass', fractionPassed: 1 }));
    expect(attribution.basis).toEqual(['The trial passed without reaching any endpoint.']);
  });

  it('an empty trajectory on a completed run keeps both exits open', () => {
    const attribution = deriveTrialAttribution(
      trialDetail({
        runStatus: 'completed',
        trajectory: [],
        expectationResults: [check(0, 'reply', false, 'wrong amount')],
        fractionPassed: 0,
      }),
    );
    expect(attribution.status).toBe('contested');
    expect(attribution.confident).toBe(false);
    expect(attribution.exits).toEqual(['contract', 'instruction']);
    expect(attribution.expandCards).toEqual(['contract', 'instruction']);
  });

  it('a failing contract check names the contract, and the refusal rides along', () => {
    const attribution = deriveTrialAttribution(
      trialDetail({
        expectationResults: [
          check(2, 'trajectory', false, 'payment_inspect was never called'),
          check(0, 'reply', false, 'wrong amount'),
        ],
        trajectory: [call(0, 'payment_list', 200), call(1, 'payment_refund', 403)],
        fractionPassed: 0,
      }),
    );
    expect(attribution.status).toBe('attributed');
    expect(attribution.headline).toBe('Likely cause: the API design');
    expect(attribution.exits).toEqual(['contract']);
    expect(attribution.basis[0]).toBe('Check #2 (trajectory): payment_inspect was never called');
    expect(attribution.basis[1]).toBe('Call #1 payment_refund returned 403.');
  });

  it('a refusal with no contract check is still the contract, flagged as unchecked', () => {
    const attribution = deriveTrialAttribution(
      trialDetail({
        expectationResults: [check(0, 'reply', false, 'wrong amount')],
        trajectory: [call(0, 'payment_refund', 422)],
        fractionPassed: 0,
      }),
    );
    expect(attribution.exits).toEqual(['contract']);
    expect(attribution.basis[1]).toContain('unchecked evidence');
  });

  it('an unresolved reply degrades an otherwise confident instruction call', () => {
    const attribution = deriveTrialAttribution(
      trialDetail({
        expectationResults: [
          check(0, 'reply', false, 'does not name the amount'),
          check(1, 'trajectory', true),
        ],
        trajectory: [call(0, 'payment_list', 200)],
        replyRef: 'inline:abc',
        fractionPassed: 0.5,
      }),
    );
    expect(attribution.status).toBe('contested');
    expect(attribution.confident).toBe(false);
    expect(attribution.exits).toEqual(['instruction', 'expectation']);
    expect(attribution.basis[0]).toBe('1 check on the answer failed.');
  });

  it('advisory judges may withhold confidence but never assert the case as the exit', () => {
    const attribution = deriveTrialAttribution(
      trialDetail({
        expectationResults: [check(0, 'reply', false, 'does not name the amount')],
        trajectory: [call(0, 'payment_list', 200)],
        reply: 'Refunded.',
        rubricResults: [
          {
            status: 'judged',
            criterionId: 'a',
            scopeKey: 'suite',
            judgeVersion: 'jv-1',
            rationale: 'reads fine',
            verdict: 'pass',
            score: 1,
          },
        ],
        fractionPassed: 0,
      }),
    );
    expect(attribution.status).toBe('contested');
    expect(attribution.confident).toBe(false);
    expect(attribution.exits).toEqual(['instruction', 'expectation']);
    expect(attribution.exits).not.toEqual(['expectation']);
  });

  it('a failing answer check with the answer in hand names the instructions', () => {
    const attribution = deriveTrialAttribution(
      trialDetail({
        expectationResults: [
          check(0, 'reply', false, 'does not name the amount'),
          check(1, 'trajectory', true),
        ],
        trajectory: [call(0, 'payment_list', 200)],
        reply: 'Refunded.',
        fractionPassed: 0.5,
      }),
    );
    expect(attribution.status).toBe('attributed');
    expect(attribution.headline).toBe('Likely cause: the instructions');
    expect(attribution.exits).toEqual(['instruction']);
    expect(attribution.confident).toBe(true);
    expect(attribution.basis).toHaveLength(1);
  });

  it('an instruction call with no contract coverage flags the unverified trajectory', () => {
    const attribution = deriveTrialAttribution(
      trialDetail({
        expectationResults: [check(0, 'reply', false, 'does not name the amount')],
        trajectory: [call(0, 'payment_list', 200)],
        reply: 'Refunded.',
        fractionPassed: 0,
      }),
    );
    expect(attribution.basis[1]).toBe(
      'No contract check covers this case, so the trajectory is unverified.',
    );
  });

  it('a fail with no failing check is reported as unattributable, never guessed', () => {
    const attribution = deriveTrialAttribution(
      trialDetail({
        expectationResults: [check(0, 'reply', true)],
        trajectory: [call(0, 'payment_list', 200)],
        reply: 'Refunded.',
        fractionPassed: 1,
      }),
    );
    expect(attribution.status).toBe('unattributable');
    expect(attribution.exits).toEqual([]);
    expect(attribution.confident).toBe(false);
  });

  it('no branch ever names the case alone as the exit', () => {
    const details: EvalTrialDetailView[] = [
      trialDetail({ verdict: undefined }),
      trialDetail({ fractionPassed: undefined }),
      trialDetail({ runStatus: 'failed' }),
      trialDetail({ verdict: 'error', gradingError: 'x' }),
      trialDetail({ verdict: 'pass', fractionPassed: 1 }),
      trialDetail({ trajectory: [], fractionPassed: 0 }),
      trialDetail({
        expectationResults: [check(0, 'reply', false, 'x')],
        trajectory: [call(0, 'a', 200)],
        replyRef: 'inline:abc',
        fractionPassed: 0,
      }),
    ];
    for (const detail of details) {
      expect(deriveTrialAttribution(detail).exits).not.toEqual(['expectation']);
    }
  });
});

describe('sibling trials', () => {
  const caseResult = (
    caseRevisionId: string,
    trial: number,
    verdict?: 'pass' | 'fail' | 'error',
  ): EvalBatchCaseResultView => ({
    caseRevisionId,
    trial,
    disposition: verdict === undefined ? 'scheduled' : 'graded',
    ...(verdict !== undefined ? { verdict } : {}),
  });

  it('filters to the case and sorts ascending by trial', () => {
    const siblings = deriveSiblingTrials(
      [
        caseResult('case-b', 1, 'pass'),
        caseResult('case-a', 3, 'fail'),
        caseResult('case-a', 1, 'pass'),
        caseResult('case-a', 2, 'pass'),
      ],
      'case-a',
    );
    expect(siblings.map((s) => s.trial)).toEqual([1, 2, 3]);
  });

  it('reports nothing below two trials — k-of-n needs an n', () => {
    expect(
      formatSiblingSummary(deriveSiblingTrials([caseResult('case-a', 1, 'pass')], 'case-a')),
    ).toBeNull();
  });

  it('summarises a fully graded case as k of n', () => {
    const siblings = deriveSiblingTrials(
      [caseResult('case-a', 1, 'pass'), caseResult('case-a', 2, 'fail')],
      'case-a',
    );
    expect(formatSiblingSummary(siblings)).toBe('1 of 2 trials of this case passed.');
  });

  it('breaks out ungraded trials rather than counting them as failures', () => {
    const siblings = deriveSiblingTrials(
      [caseResult('case-a', 1, 'pass'), caseResult('case-a', 2, 'fail'), caseResult('case-a', 3)],
      'case-a',
    );
    expect(formatSiblingSummary(siblings)).toBe('1 passed, 1 failed, 1 not graded, of 3 trials.');
  });
});

// ============================================================================
// Evidence blocks — JSON tree vs wrapped text
// ============================================================================

describe('deriveEvidenceRender', () => {
  const block = (
    content: string,
    source: 'reference_output' | 'task_summaries' | 'task_output' = 'task_output',
  ) => ({ label: 'Task output — write', content, source });

  it('renders a parseable object as a tree, value intact', () => {
    const render = deriveEvidenceRender(block('{\n  "summary": "ok",\n  "count": 2\n}'));
    expect(render).toEqual({ kind: 'json', value: { summary: 'ok', count: 2 } });
  });

  it('renders a parseable array as a tree', () => {
    const render = deriveEvidenceRender(block('[{"id":1},{"id":2}]'));
    expect(render).toEqual({ kind: 'json', value: [{ id: 1 }, { id: 2 }] });
  });

  it('leading whitespace before the brace does not hide the structure', () => {
    expect(deriveEvidenceRender(block('\n\n  {"a":1}  '))).toEqual({
      kind: 'json',
      value: { a: 1 },
    });
  });

  it('keeps prose as wrapped text — a paragraph read through a tree is unreadable', () => {
    const render = deriveEvidenceRender(
      block('The customer asked for a refund and the agent issued it.'),
    );
    expect(render).toEqual({ kind: 'text', reason: 'not_structured' });
  });

  it('keeps a string that merely opens with a brace as text when it does not parse', () => {
    expect(deriveEvidenceRender(block('{ not json }'))).toEqual({
      kind: 'text',
      reason: 'unparsed',
    });
  });

  it('keeps truncated JSON as text so its marker still reads', () => {
    expect(deriveEvidenceRender(block('{"a":1,"b":\n… [truncated]'))).toEqual({
      kind: 'text',
      reason: 'unparsed',
    });
  });

  it('keeps stringified scalars as text — a one-node tree reads worse than the value', () => {
    for (const scalar of ['42', 'true', 'null', '"hi"']) {
      expect(deriveEvidenceRender(block(scalar))).toEqual({
        kind: 'text',
        reason: 'not_structured',
      });
    }
  });

  it('never parses a summaries block — the producer is line-oriented, whatever it contains', () => {
    expect(deriveEvidenceRender(block('{"a":1}', 'task_summaries'))).toEqual({
      kind: 'text',
      reason: 'summaries',
    });
  });

  it('reports an empty block as empty rather than unparseable', () => {
    expect(deriveEvidenceRender(block(''))).toEqual({ kind: 'text', reason: 'empty' });
    expect(deriveEvidenceRender(block('   '))).toEqual({ kind: 'text', reason: 'empty' });
  });
});

// ============================================================================
// Collapsed-header readings
// ============================================================================

describe('trial rows subtitle', () => {
  const row = (trial: number, verdict?: 'pass' | 'fail'): EvalBatchCaseResultView => ({
    caseRevisionId: 'case-a',
    trial,
    disposition: verdict === undefined ? 'scheduled' : 'graded',
    ...(verdict !== undefined ? { verdict } : {}),
  });

  it('counts only failing verdicts', () => {
    expect(countFailingTrials([row(1, 'pass'), row(2, 'fail'), row(3)])).toBe(1);
  });

  it('marks a live batch’s count as partial — it must not read as a result', () => {
    expect(formatTrialsSubtitle([row(1, 'pass'), row(2, 'fail')], true)).toBe(
      '2 trial rows recorded so far · 1 failing',
    );
  });

  it('reads a terminal batch as a finished count', () => {
    expect(formatTrialsSubtitle([row(1, 'pass')], false)).toBe('1 trial row · none failing');
  });

  it('distinguishes "none yet" from "none"', () => {
    expect(formatTrialsSubtitle([], true)).toBe('no trial rows yet');
    expect(formatTrialsSubtitle([], false)).toBe('no trial rows');
  });
});

describe('comparison subtitle', () => {
  const delta = {
    rateA: 0.62,
    rateB: 0.71,
    delta: 0.09,
    intervalLower: 0.012,
    intervalUpper: 0.168,
  };
  const baselineDelta = {
    baselineBatchId: '00000000-0000-0000-0000-0000000000b0',
    pairedCases: 12,
    passToFailFlips: 1,
    failToPassFlips: 2,
    investigationFlips: 0,
    uncertaintyNote: 'note',
  };

  it('never renders a delta bare', () => {
    expect(formatDeltaCompact(delta)).toBe('Δ +9.0pp (95% CI +1.2pp, +16.8pp)');
  });

  it('says the reading is not available yet while the batch runs', () => {
    expect(
      formatComparisonSubtitle({
        terminal: false,
        isBaseline: false,
        baselinePinned: true,
        delta: undefined,
      }),
    ).toBe('reads once the batch is terminal');
  });

  it('names the ruler rather than comparing it to itself', () => {
    expect(
      formatComparisonSubtitle({
        terminal: true,
        isBaseline: true,
        baselinePinned: true,
        delta: undefined,
      }),
    ).toBe('this batch is the pinned ruler');
  });

  it('reports an unpinned baseline', () => {
    expect(
      formatComparisonSubtitle({
        terminal: true,
        isBaseline: false,
        baselinePinned: false,
        delta: undefined,
      }),
    ).toBe('no baseline pinned');
  });

  it('carries pass^k with its interval and the flip count', () => {
    expect(
      formatComparisonSubtitle({
        terminal: true,
        isBaseline: false,
        baselinePinned: true,
        delta: { ...baselineDelta, perCaseSuccess: delta },
      }),
    ).toBe('pass^k Δ +9.0pp (95% CI +1.2pp, +16.8pp) · 3 flips');
  });

  it('falls back to the pairing size when pass^k did not resolve', () => {
    expect(
      formatComparisonSubtitle({
        terminal: true,
        isBaseline: false,
        baselinePinned: true,
        delta: { ...baselineDelta, passToFailFlips: 0, failToPassFlips: 0 },
      }),
    ).toBe('n=12 paired cases · no flips');
  });

  it('says so when a baseline is pinned but nothing paired yet', () => {
    expect(
      formatComparisonSubtitle({
        terminal: true,
        isBaseline: false,
        baselinePinned: true,
        delta: undefined,
      }),
    ).toBe('no paired comparison yet');
  });
});

describe('status-line tally', () => {
  const row = (trial: number, verdict?: 'pass' | 'fail' | 'error'): EvalBatchCaseResultView => ({
    caseRevisionId: 'case-a',
    trial,
    disposition: verdict === undefined ? 'scheduled' : 'graded',
    ...(verdict !== undefined ? { verdict } : {}),
  });

  it('counts only graded rows toward passed and failed', () => {
    expect(deriveTrialTally([row(1, 'pass'), row(2, 'fail'), row(3, 'error'), row(4)])).toEqual({
      rows: 4,
      graded: 3,
      passed: 1,
      failed: 1,
    });
  });

  it('reads the pass count against what was graded, never against every row', () => {
    expect(formatTrialTally(deriveTrialTally([row(1, 'pass'), row(2, 'pass')]))).toBe(
      '2/2 trials passed',
    );
  });

  it('names the ungraded rows rather than folding them into a failure', () => {
    expect(formatTrialTally(deriveTrialTally([row(1, 'pass'), row(2), row(3)]))).toBe(
      '1/1 trials passed · 2 not graded yet',
    );
  });

  it('says nothing was graded instead of reading 0 as a result', () => {
    expect(formatTrialTally(deriveTrialTally([row(1), row(2)]))).toBe('0 of 2 trials graded');
  });

  it('has no reading with no rows', () => {
    expect(formatTrialTally(deriveTrialTally([]))).toBeNull();
  });
});

describe('batch size reading', () => {
  it('reads size and spend against the ceiling, singulars included', () => {
    expect(
      formatBatchSize({
        caseCount: 1,
        trialsPerCase: 1,
        costSpentCents: 4,
        costCeilingCents: 200,
      }),
    ).toBe('1 case × 1 trial · 4¢ of $2.00');
  });

  it('pluralises both counts', () => {
    expect(
      formatBatchSize({
        caseCount: 12,
        trialsPerCase: 3,
        costSpentCents: 0,
        costCeilingCents: 100,
      }),
    ).toBe('12 cases × 3 trials · 0¢ of $1.00');
  });
});

describe('deriveReviewQueue', () => {
  const item = (
    id: string,
    caseRevisionId: string,
    caseTitle: string | null,
    available: boolean,
  ): LabelQueueItem =>
    ({
      id,
      caseRevisionId,
      caseTitle,
      criterionId: 'clarity',
      trial: 1,
      evidence: available
        ? {
            status: 'available',
            taskSummaries: [],
            taskOutputs: [],
            conversation: { request: 'Where is my refund?', reply: 'Refunded today.' },
            unresolvedArtifacts: 0,
          }
        : { status: 'unavailable', reason: 'run_reaped', detail: 'gone' },
    }) as unknown as LabelQueueItem;

  it('holds items whose evidence is gone apart from reviewable work', () => {
    // These carry no reply, so offering one as the next item asks for a guess.
    const queue = deriveReviewQueue([
      item('a', 'case-1', 'A case', false),
      item('b', 'case-1', 'A case', true),
    ]);
    expect(queue.unavailable.map((i) => i.id)).toEqual(['a']);
    expect(queue.order.map((i) => i.id)).toEqual(['b']);
  });

  it('groups the same case across dataset versions under one heading', () => {
    // A queue spans batches; each pinned a different dataset version, so one
    // case arrives under several revision ids.
    const queue = deriveReviewQueue([
      item('a', 'rev-v36', 'A refund inside its window', true),
      item('b', 'rev-v42', 'A refund inside its window', true),
    ]);
    expect(queue.groups).toHaveLength(1);
    expect(queue.groups[0]?.items).toHaveLength(2);
  });

  it('groups reviewable items by case so one title is not repeated per trial', () => {
    const queue = deriveReviewQueue([
      item('a', 'case-1', 'First', true),
      item('b', 'case-2', 'Second', true),
      item('c', 'case-1', 'First', true),
    ]);
    expect(queue.groups.map((g) => [g.caseTitle, g.items.length])).toEqual([
      ['First', 2],
      ['Second', 1],
    ]);
  });

  it('walks the pager in group order, not arrival order', () => {
    const queue = deriveReviewQueue([
      item('a', 'case-1', 'First', true),
      item('b', 'case-2', 'Second', true),
      item('c', 'case-1', 'First', true),
    ]);
    expect(queue.order.map((i) => i.id)).toEqual(['a', 'c', 'b']);
  });

  it('falls back to the case id when a title is missing', () => {
    const queue = deriveReviewQueue([item('a', 'abcdef1234', null, true)]);
    expect(queue.groups[0]?.caseTitle).toBe('abcdef12');
  });
});

describe('deriveReviewQueue — order within a group', () => {
  const item = (id: string, criterionId: string, trial: number): LabelQueueItem =>
    ({
      id,
      caseRevisionId: 'case-1',
      caseTitle: 'A case',
      criterionId,
      trial,
      evidence: {
        status: 'available',
        taskSummaries: [],
        taskOutputs: [],
        conversation: { request: 'Q', reply: 'A' },
        unresolvedArtifacts: 0,
      },
    }) as unknown as LabelQueueItem;

  it('reads question-then-trial, not arrival order — the rail and the walk share it', () => {
    const queue = deriveReviewQueue([
      item('a', 'clarity', 3),
      item('b', 'accuracy', 2),
      item('c', 'clarity', 1),
    ]);
    expect(queue.order.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('deriveCaseReview', () => {
  const content = {
    title: 'An overdue merchant refund is escalated',
    notes: 'OI-R3. The refund is past its window.',
    stratum: { scenario: 'refunds', direction: 'should_succeed', tier: 'capability' },
    trigger: { inputs: { message: 'Where is my refund from Jarir?' } },
    fixture: {
      tier: 'sealed',
      learnings: 'none',
      bindings: [
        {
          integrationId: 'cs-desk',
          mode: 'stub',
          simulationId: 'cs-desk',
          personaId: 'cus_sa_amal',
        },
      ],
    },
    expectations: [
      {
        kind: 'simulation',
        name: 'read the order first',
        check: { op: 'called', endpointId: 'order_inspect', expect: 'any' },
      },
      {
        kind: 'simulation',
        name: 'opened no case',
        check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
      },
      { kind: 'reply', name: 'names the amount', check: { op: 'contains', pattern: '200' } },
      {
        kind: 'reply',
        name: 'claims no transfer',
        check: { op: 'not_contains', pattern: 'has been escalated' },
      },
    ],
    rubrics: [
      {
        kind: 'case_local',
        criterion: {
          type: 'judge',
          name: 'transfer etiquette',
          rubric: [
            { criterion: 'asks permission before transferring', description: 'x', scale: 'binary' },
          ],
        },
      },
    ],
    provenance: { source: 'curated' },
  } as unknown as GoldenCaseContent;

  it('reads the case as a request in a world, not as its storage', () => {
    const review = deriveCaseReview(content);
    expect(review.request).toBe('Where is my refund from Jarir?');
    expect(review.personaId).toBe('cus_sa_amal');
    expect(review.worldId).toBe('cs-desk');
    expect(review.why).toContain('OI-R3');
  });

  it('names the instrument, so a language-fragile check is visible as one', () => {
    // A text match is a regex over the reply: it holds for an identifier and
    // fails the moment the same fact is written in another script.
    const review = deriveCaseReview(content);
    expect(review.requirements.map((r) => r.instrument)).toEqual([
      'tool call',
      'world change',
      'text match',
      'text match',
    ]);
  });

  it('marks a prohibition apart from a requirement', () => {
    // "must not say" and "must say" read identically as a bare list.
    const review = deriveCaseReview(content);
    expect(review.requirements.map((r) => [r.text, r.forbidden])).toEqual([
      ['read the order first', false],
      ['opened no case', true],
      ['names the amount', false],
      ['claims no transfer', true],
    ]);
  });

  it('surfaces each judge question the case carries', () => {
    expect(deriveCaseReview(content).judgeAsks).toEqual(['asks permission before transferring']);
  });
});

describe('deriveCaseRollup', () => {
  const trial = (
    caseRevisionId: string,
    t: number,
    outcomeClass: string,
  ): EvalBatchCaseResultView =>
    ({
      caseRevisionId,
      caseTitle: caseRevisionId === 'a' ? 'First case' : 'Second case',
      trial: t,
      disposition: 'graded',
      outcomeClass,
      aggregationVersion: 'ordered-four-axis-1',
      costCents: 1,
    }) as unknown as EvalBatchCaseResultView;

  it('folds a batch to one row per case with the pass count trials were run to measure', () => {
    const rollup = deriveCaseRollup(
      [
        trial('a', 1, 'behavior_pass'),
        trial('a', 2, 'behavior_pass'),
        trial('a', 3, 'behavior_pass'),
      ],
      3,
    );
    expect(rollup).toHaveLength(1);
    expect([rollup[0]?.passed, rollup[0]?.total, rollup[0]?.anyFailing]).toEqual([3, 3, false]);
    expect(rollup[0]?.passAllTrials).toBe(true);
    expect(rollup[0]?.costCents).toBe(3);
  });

  it('does not count an execution error as a case the agent failed', () => {
    // The defect this replaces: `verdict !== 'pass'` folded an infrastructure
    // failure into anyFailing, so a red cell blamed the design for the harness.
    const rollup = deriveCaseRollup(
      [
        trial('a', 1, 'behavior_pass'),
        trial('a', 2, 'behavior_pass'),
        trial('a', 3, 'execution_error'),
      ],
      3,
    );
    expect(rollup[0]?.anyFailing).toBe(false);
    expect(rollup[0]?.scored).toBe(2);
    expect(rollup[0]?.excluded.execution_error).toBe(1);
  });

  it('refuses a pass^k claim when a trial was not scored', () => {
    const rollup = deriveCaseRollup(
      [
        trial('a', 1, 'behavior_pass'),
        trial('a', 2, 'behavior_pass'),
        trial('a', 3, 'execution_error'),
      ],
      3,
    );
    expect(rollup[0]?.complete).toBe(false);
    expect(rollup[0]?.passAllTrials).toBe(false);
  });

  it('does not let the rows that arrived redefine the configured k', () => {
    const rollup = deriveCaseRollup([trial('a', 1, 'behavior_pass')], 3);
    expect(rollup[0]?.complete).toBe(false);
    expect(rollup[0]?.passAllTrials).toBe(false);
  });

  it('treats a row graded before the class existed as unreadable, not as a pass', () => {
    const legacy = {
      caseRevisionId: 'a',
      trial: 1,
      disposition: 'graded',
      verdict: 'pass',
      costCents: 1,
    } as unknown as EvalBatchCaseResultView;
    const rollup = deriveCaseRollup([legacy], 1);
    expect(rollup[0]?.scored).toBe(0);
    expect(rollup[0]?.excluded.incomplete_evidence).toBe(1);
    expect(rollup[0]?.passAllTrials).toBe(false);
  });

  it('puts a case that did not fully pass first — that is what the reader came for', () => {
    const rollup = deriveCaseRollup(
      [
        trial('a', 1, 'behavior_pass'),
        trial('b', 1, 'behavior_pass'),
        trial('b', 2, 'behavior_fail'),
      ],
      2,
    );
    expect(rollup.map((row) => [row.caseRevisionId, row.anyFailing])).toEqual([
      ['b', true],
      ['a', false],
    ]);
  });

  it('orders trials within a case by trial number, whatever order they arrived in', () => {
    const rollup = deriveCaseRollup(
      [trial('a', 3, 'behavior_pass'), trial('a', 1, 'behavior_pass')],
      3,
    );
    expect(rollup[0]?.trials.map((t) => t.trial)).toEqual([1, 3]);
  });
});

describe('deriveItemReadability', () => {
  const withEvidence = (evidence: unknown): { evidence?: EvalLabelQueueEvidence } =>
    ({ evidence }) as { evidence?: EvalLabelQueueEvidence };

  it('reads an item that carries a reply', () => {
    expect(
      deriveItemReadability(
        withEvidence({
          status: 'available',
          taskSummaries: [],
          taskOutputs: [],
          conversation: { request: 'ask', reply: 'answer' },
          unresolvedArtifacts: 0,
        }),
      ),
    ).toEqual({ readable: true, reason: null });
  });

  it('reads an item whose evidence pack is all there is', () => {
    // A trial with no captured reply can still be judged from the pack the
    // judge itself read.
    const readability = deriveItemReadability(
      withEvidence({
        status: 'available',
        taskSummaries: [{ taskId: 'draft', status: 'succeeded' }],
        taskOutputs: [],
        unresolvedArtifacts: 0,
      }),
    );
    expect(readability.readable).toBe(true);
  });

  it('holds back an available item that carries neither a reply nor a block', () => {
    // Routing on the status alone walks this one into the form as a blank area.
    const readability = deriveItemReadability(
      withEvidence({
        status: 'available',
        taskSummaries: [],
        taskOutputs: [],
        unresolvedArtifacts: 0,
      }),
    );
    expect(readability.readable).toBe(false);
    expect(readability.reason).toContain('nothing to read');
  });

  it('holds back an item that shipped without evidence at all', () => {
    const readability = deriveItemReadability({});
    expect(readability.readable).toBe(false);
    expect(readability.reason).toContain('not included');
  });

  it('speaks for the pile, not for one item', () => {
    // The server's own detail is addressed to one reviewer about one item and
    // ends by naming a control this surface does not have.
    const readability = deriveItemReadability(
      withEvidence({
        status: 'unavailable',
        reason: 'run_reaped',
        detail: 'The run behind this trial has been cleaned up. Dismiss this item.',
      }),
    );
    expect(readability.readable).toBe(false);
    expect(readability.reason).toBe(
      'The runs behind these were cleaned up before a mark was recorded, so there is no reply left to read.',
    );
  });

  it('has a sentence for every reason the schema can carry', () => {
    const reasons = [
      'no_trial_run',
      'run_reaped',
      'case_revision_missing',
      'payload_store_unavailable',
      'rebuild_failed',
    ] as const;
    for (const reason of reasons) {
      const readability = deriveItemReadability(
        withEvidence({ status: 'unavailable', reason, detail: 'x' }),
      );
      expect(readability.reason).not.toBe('x');
      expect((readability.reason ?? '').length).toBeGreaterThan(20);
    }
  });
});

describe('deriveQueuePosition', () => {
  const item = (id: string): LabelQueueItem => ({ id }) as unknown as LabelQueueItem;

  it('finds the open item', () => {
    const position = deriveQueuePosition([item('a'), item('b')], 'b');
    expect([position?.index, position?.item.id]).toEqual([1, 'b']);
  });

  it('falls to the head when the open id has left the queue — that IS the advance', () => {
    const position = deriveQueuePosition([item('a'), item('b')], 'gone');
    expect([position?.index, position?.item.id]).toEqual([0, 'a']);
  });

  it('has no position in an empty walk', () => {
    expect(deriveQueuePosition([], 'a')).toBeNull();
  });
});

describe('summariseUnreadable', () => {
  const item = (caseTitle: string | null): LabelQueueItem =>
    ({ caseTitle, caseRevisionId: 'abcdef1234' }) as unknown as LabelQueueItem;

  it('names the cases the pile came from, biggest contributor first', () => {
    // A whole reaped batch reads differently from a scatter across the dataset.
    expect(summariseUnreadable([item('A refund'), item('A late delivery'), item('A refund')])).toBe(
      'From: A refund (2), A late delivery (1)',
    );
  });

  it('falls back to the case id when a title is missing', () => {
    expect(summariseUnreadable([item(null)])).toBe('From: abcdef12 (1)');
  });
});

describe('deriveSubmitGate', () => {
  it('opens once a reason is written', () => {
    expect(
      deriveSubmitGate({ critique: 'names the amount', pending: false, readable: true }),
    ).toEqual({ canSubmit: true, hint: null });
  });

  it('says a reason is required rather than greying out in silence', () => {
    const gate = deriveSubmitGate({ critique: '   ', pending: false, readable: true });
    expect([gate.canSubmit, gate.hint]).toEqual([false, 'A reason is required before marking.']);
  });

  it('never opens for an item with nothing to read', () => {
    // Marking without the judge's material confounds the confusion matrix.
    const gate = deriveSubmitGate({ critique: 'looks fine', pending: false, readable: false });
    expect(gate.canSubmit).toBe(false);
    expect(gate.hint).toContain('Discard it.');
  });

  it('shuts while a mark is in flight', () => {
    expect(deriveSubmitGate({ critique: 'ok', pending: true, readable: true })).toEqual({
      canSubmit: false,
      hint: 'Recording…',
    });
  });
});

describe('formatEvidencePreview', () => {
  const block = (content: string): JudgeEvidenceBlock => ({
    label: 'Run artifacts',
    content,
    source: 'task_summaries',
  });

  it('shows the first line that carries something', () => {
    expect(formatEvidencePreview(block('\n\n  refund issued  \nsecond line'))).toBe(
      'refund issued',
    );
  });

  it('truncates a long line rather than filling the row', () => {
    const preview = formatEvidencePreview(block('x'.repeat(200)));
    expect(preview).toHaveLength(81);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('says so when a block holds nothing', () => {
    expect(formatEvidencePreview(block('   \n  '))).toBe('empty');
  });
});

describe('readApiErrorCode', () => {
  it('reads the route’s machine-readable code', () => {
    expect(readApiErrorCode({ error: 'label_exists', message: 'x' })).toBe('label_exists');
  });

  it('has no code to read from a plain-text body', () => {
    expect(readApiErrorCode('502 Bad Gateway')).toBeNull();
    expect(readApiErrorCode(null)).toBeNull();
  });
});

describe('deriveSubmitFailure', () => {
  it('offers a way past an item that was resolved elsewhere', () => {
    // Without this the queue pins on one row that can never be submitted.
    const failure = deriveSubmitFailure({
      status: 409,
      code: 'label_exists',
      message: 'A label already exists.',
    });
    expect(failure.stranded).toBe(true);
    expect(failure.text).toContain('already resolved elsewhere');
  });

  it('points an unlabelable item at Discard rather than stranding it', () => {
    const failure = deriveSubmitFailure({
      status: 409,
      code: 'queue_item_unlabelable',
      message: 'no run',
    });
    expect(failure.stranded).toBe(false);
    expect(failure.text).toContain('Discard it.');
  });

  it('keeps the server’s words for anything worth retrying', () => {
    expect(
      deriveSubmitFailure({ status: 500, code: null, message: 'Database unavailable.' }),
    ).toEqual({
      text: 'The mark was not recorded. Database unavailable.',
      stranded: false,
    });
  });
});

describe('Review surface — anchoring invariant', () => {
  // Every one of these names the judge's verdict exactly, so a row that shows
  // one beside the Pass/Fail buttons anchors the labeler. They are null on a
  // pending row today; the rule is that no future field reaches this surface
  // without the same test.
  const SOURCE = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), 'ReviewSection.tsx'),
    'utf8',
  );

  it.each(['partition', 'source', 'inclusionProbability', 'batchId', 'runId'])(
    'never renders %s',
    (field) => {
      expect(SOURCE.includes(`.${field}`)).toBe(false);
    },
  );

  it('names the trial on the bench — the item in hand is one trial of a case', () => {
    expect(SOURCE).toContain('trial {item.trial}');
  });
});
