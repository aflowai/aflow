/**
 * D10 label-queue planning: the uniform seeded draw is the only validation
 * minter (never re-rolls, inclusion probability persisted), exemplar routing
 * is source-tagged and never silent, and the label values a queue item
 * produces carry the ITEM's partition — the submit caller cannot choose one.
 */
import { describe, expect, it } from 'vitest';
import {
  EvalBatchProvenanceManifestSchema,
  EvalCaseTrialResultsSchema,
  GoldenCaseRevisionSchema,
  type EvalBatchProvenanceManifest,
  type GoldenCaseRevision,
} from '@aflow/schemas';
import {
  buildLabelValuesFromQueueItem,
  discloseLabelQueueStreamForList,
  deriveValidationSliceSize,
  isValidationSliceEligible,
  planLabelQueueForBatch,
  VALIDATION_SLICE_DEFAULT_SHARE,
  VALIDATION_SLICE_FLOOR,
  type LabelQueueTrialRow,
} from '../evalLabelQueue.js';
import { rubricScopeKey } from '../evalBatchJudge.js';
import { createSeededRng, seedFromString } from '../judgeScorecard.js';

// ============================================================================
// Slice-size derivation
// ============================================================================

describe('deriveValidationSliceSize', () => {
  it('derives share × (cases × trials), floored', () => {
    // 100 × 2 = 200 trials → 10% share = 20.
    expect(deriveValidationSliceSize({ caseCount: 100, trialsPerCase: 2 })).toBe(
      Math.ceil(200 * VALIDATION_SLICE_DEFAULT_SHARE),
    );
    // 10 × 3 = 30 trials → share says 3, the floor lifts it to 5.
    expect(deriveValidationSliceSize({ caseCount: 10, trialsPerCase: 3 })).toBe(
      VALIDATION_SLICE_FLOOR,
    );
  });

  it('never exceeds the batch and honors the explicit knob (0 opts out)', () => {
    expect(deriveValidationSliceSize({ caseCount: 2, trialsPerCase: 1 })).toBe(2);
    expect(deriveValidationSliceSize({ caseCount: 3, trialsPerCase: 1, requested: 50 })).toBe(3);
    expect(deriveValidationSliceSize({ caseCount: 100, trialsPerCase: 3, requested: 0 })).toBe(0);
    expect(deriveValidationSliceSize({ caseCount: 100, trialsPerCase: 3, requested: 7 })).toBe(7);
  });
});

// ============================================================================
// Fixtures
// ============================================================================

const DATASET_ID = '00000000-0000-4000-8000-00000000d5e7';
const REV_WITH_RUBRICS = '00000000-0000-4000-8000-0000000000a1';
const REV_NO_RUBRICS = '00000000-0000-4000-8000-0000000000a2';
const REV_TWO_RUBRICS = '00000000-0000-4000-8000-0000000000a3';

function revision(revisionId: string, rubricNames: readonly string[]): GoldenCaseRevision {
  return GoldenCaseRevisionSchema.parse({
    revisionId,
    caseId: '00000000-0000-4000-8000-0000000000c1',
    datasetId: DATASET_ID,
    addedInVersion: 1,
    status: 'active',
    case: {
      caseId: '00000000-0000-4000-8000-0000000000c1',
      datasetId: DATASET_ID,
      title: `Case ${revisionId.slice(-2)}`,
      stratum: { scenario: 'happy-path', direction: 'should_succeed', tier: 'regression' },
      trigger: { inputs: {} },
      fixture: { tier: 'seeded', learnings: 'none' },
      expectations: [{ kind: 'terminal', runStatus: 'completed' }],
      rubrics: rubricNames.map((name) => ({
        kind: 'case_local',
        criterion: {
          type: 'judge',
          name,
          rubric: [{ criterion: `${name} check`, scale: 'binary', description: 'desc' }],
        },
      })),
      provenance: { source: 'curated', workflowRevision: 1 },
    },
  });
}

const REVISIONS = new Map<string, GoldenCaseRevision>([
  [REV_WITH_RUBRICS, revision(REV_WITH_RUBRICS, ['clarity'])],
  [REV_NO_RUBRICS, revision(REV_NO_RUBRICS, [])],
  [REV_TWO_RUBRICS, revision(REV_TWO_RUBRICS, ['clarity', 'depth'])],
]);

const MANIFEST: EvalBatchProvenanceManifest = EvalBatchProvenanceManifestSchema.parse({
  workflow: { slug: 'daily-metrics', revision: 1, configHash: 'hash' },
  dataset: { datasetId: DATASET_ID, datasetVersion: 1 },
  graderVersion: 'det-1',
  judgeVersions: {
    [`${REV_WITH_RUBRICS}/clarity`]: 'jv-clarity',
    [`${REV_TWO_RUBRICS}/clarity`]: 'jv-clarity-2',
    [`${REV_TWO_RUBRICS}/depth`]: 'jv-depth',
  },
});

/**
 * One recorded result per declared expectation. A fixture that declares a
 * check and records none is not a passing trial — it is an unreadable one, and
 * writing it that way hid a real hole: a partial record read as a clean
 * deterministic pass.
 */
function passResults(rubricResults: unknown[] = []): unknown {
  return EvalCaseTrialResultsSchema.parse({
    expectationResults: [{ expectationIndex: 0, kind: 'terminal', passed: true }],
    fractionPassed: 1,
    fixtureTier: 'seeded',
    rubricResults,
  });
}

/** A trial whose deterministic checks genuinely failed — the instrument spoke. */
function checkFailResults(): unknown {
  return EvalCaseTrialResultsSchema.parse({
    expectationResults: [
      { expectationIndex: 0, kind: 'terminal', passed: false, detail: 'missing' },
    ],
    fractionPassed: 0,
    fixtureTier: 'seeded',
    rubricResults: [],
  });
}

function gradedTrial(
  revisionId: string,
  trial: number,
  verdict: 'pass' | 'fail' | 'error',
  rubricResults: unknown[] = [],
): LabelQueueTrialRow {
  return {
    caseRevisionId: revisionId,
    trial,
    runId: `run-${revisionId.slice(-2)}-${String(trial)}`,
    disposition: 'graded',
    verdict,
    resultsJson: passResults(rubricResults),
  };
}

/**
 * A graded trial the deterministic instrument failed. Distinct from
 * `gradedTrial(..., 'fail')`, which a judge can now produce on its own.
 */
function checkFailedTrial(revisionId: string, trial: number): LabelQueueTrialRow {
  return {
    caseRevisionId: revisionId,
    trial,
    runId: `run-${revisionId.slice(-2)}-${String(trial)}`,
    disposition: 'graded',
    verdict: 'fail',
    resultsJson: checkFailResults(),
  };
}

// ============================================================================
// The validation slice
// ============================================================================

describe('planLabelQueueForBatch — validation slice', () => {
  const trials: LabelQueueTrialRow[] = [1, 2, 3, 4, 5, 6].map((t) =>
    gradedTrial(REV_WITH_RUBRICS, t, 'pass'),
  );

  it('draws uniformly, records the shared inclusion probability, and fans out per rubric', () => {
    const items = planLabelQueueForBatch({
      trialRows: trials,
      revisionsById: REVISIONS,
      manifest: MANIFEST,
      validationSliceSize: 2,
      rng: createSeededRng(seedFromString('batch-1')),
    });
    const validation = items.filter((i) => i.partition === 'validation');
    expect(validation).toHaveLength(2);
    for (const item of validation) {
      expect(item.source).toBe('random_slice');
      expect(item.inclusionProbability).toBeCloseTo(2 / 6, 10);
      expect(item.criterionId).toBe('clarity');
      expect(item.scopeKey).toBe('case_local');
      expect(item.judgeVersion).toBe('jv-clarity');
    }
  });

  it('NEVER re-rolls: the same seed re-derives the identical draw', () => {
    const draw = () =>
      planLabelQueueForBatch({
        trialRows: trials,
        revisionsById: REVISIONS,
        manifest: MANIFEST,
        validationSliceSize: 3,
        rng: createSeededRng(seedFromString('batch-1')),
      });
    expect(draw()).toEqual(draw());
  });

  it('a different batch seed draws a different sample', () => {
    const draw = (seed: string) =>
      planLabelQueueForBatch({
        trialRows: trials,
        revisionsById: REVISIONS,
        manifest: MANIFEST,
        validationSliceSize: 2,
        rng: createSeededRng(seedFromString(seed)),
      }).map((i) => `${i.caseRevisionId}:${String(i.trial)}`);
    expect(draw('batch-1')).not.toEqual(draw('batch-2'));
  });

  it('refuses a record that declares checks and recorded none', () => {
    // `every(passed)` is vacuously true on an empty array, so a partial record
    // read as a clean deterministic pass and entered the population that
    // precision and recall are computed over.
    const partial: LabelQueueTrialRow = {
      ...gradedTrial(REV_WITH_RUBRICS, 9, 'pass'),
      resultsJson: EvalCaseTrialResultsSchema.parse({
        expectationResults: [],
        fractionPassed: 1,
        fixtureTier: 'seeded',
        rubricResults: [],
      }),
    };
    expect(isValidationSliceEligible(partial, REVISIONS.get(REV_WITH_RUBRICS))).toBe(false);
  });

  it('samples only the judge population: graded, deterministic-pass, rubric-bearing', () => {
    const rows: LabelQueueTrialRow[] = [
      gradedTrial(REV_WITH_RUBRICS, 1, 'pass'),
      // A judge-decided failure: every check passed, so the judge ran and this
      // is squarely the population. Excluding it would select the sample by
      // the very verdict the scorecard measures.
      gradedTrial(REV_WITH_RUBRICS, 2, 'fail'),
      checkFailedTrial(REV_WITH_RUBRICS, 5),
      gradedTrial(REV_WITH_RUBRICS, 3, 'error'),
      gradedTrial(REV_NO_RUBRICS, 1, 'pass'),
      { ...gradedTrial(REV_WITH_RUBRICS, 4, 'pass'), disposition: 'cancelled' },
    ];
    expect(rows.map((r) => isValidationSliceEligible(r, REVISIONS.get(r.caseRevisionId)))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    const items = planLabelQueueForBatch({
      trialRows: rows,
      revisionsById: REVISIONS,
      manifest: MANIFEST,
      validationSliceSize: 10,
      rng: createSeededRng(1),
    });
    const validation = items.filter((i) => i.partition === 'validation');
    expect(validation.map((i) => i.trial).sort()).toEqual([1, 2]);
    expect(validation[0]!.inclusionProbability).toBe(1);
  });

  it('a two-rubric case mints one item per (trial × rubric criterion)', () => {
    const items = planLabelQueueForBatch({
      trialRows: [gradedTrial(REV_TWO_RUBRICS, 1, 'pass')],
      revisionsById: REVISIONS,
      manifest: MANIFEST,
      validationSliceSize: 1,
      rng: createSeededRng(1),
    });
    expect(items.map((i) => i.criterionId).sort()).toEqual(['clarity', 'depth']);
    expect(items.map((i) => i.judgeVersion).sort()).toEqual(['jv-clarity-2', 'jv-depth']);
  });
});

// ============================================================================
// Exemplar routing
// ============================================================================

describe('planLabelQueueForBatch — exemplar sources', () => {
  it('routes a judged fail that contradicts a deterministic pass as judge_disagreement', () => {
    const items = planLabelQueueForBatch({
      trialRows: [
        gradedTrial(REV_WITH_RUBRICS, 1, 'pass', [
          {
            status: 'judged',
            criterionId: 'clarity',
            scopeKey: 'case_local',
            judgeVersion: 'jv-clarity',
            rationale: 'weak',
            verdict: 'fail',
            score: 0.2,
          },
        ]),
      ],
      revisionsById: REVISIONS,
      manifest: MANIFEST,
      validationSliceSize: 0,
      rng: createSeededRng(1),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      partition: 'exemplar',
      source: 'judge_disagreement',
      criterionId: 'clarity',
      judgeVersion: 'jv-clarity',
    });
    expect(items[0]!.inclusionProbability).toBeUndefined();
  });

  it('routes a judged fail as judge_fail when a SIBLING trial of the case failed deterministically', () => {
    // Judged results only exist on deterministic-pass trials (fails
    // short-circuit the judge stage), so agreement is a case-level claim:
    // the deterministic instrument also found this case bad, on another
    // trial.
    const items = planLabelQueueForBatch({
      trialRows: [
        checkFailedTrial(REV_WITH_RUBRICS, 1),
        gradedTrial(REV_WITH_RUBRICS, 2, 'pass', [
          {
            status: 'judged',
            criterionId: 'clarity',
            scopeKey: 'case_local',
            judgeVersion: 'jv-clarity',
            rationale: 'weak',
            verdict: 'fail',
            score: 0.2,
          },
        ]),
      ],
      revisionsById: REVISIONS,
      manifest: MANIFEST,
      validationSliceSize: 0,
      rng: createSeededRng(1),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ partition: 'exemplar', source: 'judge_fail', trial: 2 });
  });

  it('a judge-only fail is a disagreement, not agreement with a check that never fired', () => {
    // A judge decides a trial, so a sibling's `verdict: 'fail'` no longer
    // implies the deterministic instrument found anything. Reading the verdict
    // here would file every judge-caught failure as the judge AGREEING.
    const items = planLabelQueueForBatch({
      trialRows: [
        gradedTrial(REV_WITH_RUBRICS, 1, 'fail', [
          {
            status: 'judged',
            criterionId: 'clarity',
            scopeKey: 'case_local',
            judgeVersion: 'jv-clarity',
            rationale: 'invented a timing',
            verdict: 'fail',
            score: 0,
          },
        ]),
      ],
      revisionsById: REVISIONS,
      manifest: MANIFEST,
      validationSliceSize: 0,
      rng: createSeededRng(1),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ partition: 'exemplar', source: 'judge_disagreement' });
  });

  it("a grader-error sibling does NOT make a judged fail 'agree' — error is grader fault, not a verdict", () => {
    const items = planLabelQueueForBatch({
      trialRows: [
        gradedTrial(REV_WITH_RUBRICS, 1, 'error'),
        gradedTrial(REV_WITH_RUBRICS, 2, 'pass', [
          {
            status: 'judged',
            criterionId: 'clarity',
            scopeKey: 'case_local',
            judgeVersion: 'jv-clarity',
            rationale: 'weak',
            verdict: 'fail',
            score: 0.2,
          },
        ]),
      ],
      revisionsById: REVISIONS,
      manifest: MANIFEST,
      validationSliceSize: 0,
      rng: createSeededRng(1),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ partition: 'exemplar', source: 'judge_disagreement' });
  });

  it('judged passes, errors, and sampling skips mint nothing', () => {
    const items = planLabelQueueForBatch({
      trialRows: [
        gradedTrial(REV_WITH_RUBRICS, 1, 'pass', [
          {
            status: 'judged',
            criterionId: 'clarity',
            scopeKey: 'case_local',
            judgeVersion: 'jv-clarity',
            rationale: 'fine',
            verdict: 'pass',
            score: 0.9,
          },
        ]),
        gradedTrial(REV_WITH_RUBRICS, 2, 'pass', [
          { status: 'not_selected', criterionId: 'clarity', scopeKey: 'case_local' },
        ]),
        gradedTrial(REV_WITH_RUBRICS, 3, 'pass', [
          {
            status: 'error',
            criterionId: 'clarity',
            scopeKey: 'case_local',
            errorCode: 'judge_dispatch_failed',
            errorMessage: 'timeout',
          },
        ]),
      ],
      revisionsById: REVISIONS,
      manifest: MANIFEST,
      validationSliceSize: 0,
      rng: createSeededRng(1),
    });
    expect(items).toEqual([]);
  });

  it('a drawn subject stays validation — the exemplar duplicate is dropped', () => {
    const items = planLabelQueueForBatch({
      trialRows: [
        gradedTrial(REV_WITH_RUBRICS, 1, 'pass', [
          {
            status: 'judged',
            criterionId: 'clarity',
            scopeKey: 'case_local',
            judgeVersion: 'jv-clarity',
            rationale: 'weak',
            verdict: 'fail',
            score: 0.1,
          },
        ]),
      ],
      revisionsById: REVISIONS,
      manifest: MANIFEST,
      validationSliceSize: 1,
      rng: createSeededRng(1),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.partition).toBe('validation');
    expect(items[0]!.source).toBe('random_slice');
  });
});

// ============================================================================
// Label materialization — the P1 partition seam, closed
// ============================================================================

describe('buildLabelValuesFromQueueItem', () => {
  it('stamps every stream-determined field from the ITEM; the caller supplies only judgment', () => {
    const values = buildLabelValuesFromQueueItem(
      {
        spaceId: 'space-1',
        batchId: 'batch-1',
        caseRevisionId: REV_WITH_RUBRICS,
        trial: 3,
        runId: 'run-a1-3',
        criterionId: 'clarity',
        scopeKey: 'case_local',
        partition: 'validation',
        judgeVersion: 'jv-clarity',
      },
      { verdict: 'fail', critique: 'Cited a fabricated figure.', labeledByUserId: 'user-1' },
    );
    expect(values).toEqual({
      spaceId: 'space-1',
      runId: 'run-a1-3',
      caseRevisionId: REV_WITH_RUBRICS,
      batchId: 'batch-1',
      trial: 3,
      criterionId: 'clarity',
      scopeKey: 'case_local',
      verdict: 'fail',
      critique: 'Cited a fabricated figure.',
      judgeVersion: 'jv-clarity',
      partition: 'validation',
      labeledByUserId: 'user-1',
    });
  });
});

describe('discloseLabelQueueStreamForList', () => {
  it('withholds the whole stream group while pending — no field survives to name the verdict', () => {
    for (const source of ['judge_disagreement', 'judge_fail', 'operator_flag'] as const) {
      expect(
        discloseLabelQueueStreamForList('pending', {
          partition: 'exemplar',
          source,
          inclusionProbability: null,
        }),
      ).toEqual({ partition: null, source: null, inclusionProbability: null });
    }
  });

  it('withholds the random slice too — a disclosed draw makes its absence name the rest', () => {
    expect(
      discloseLabelQueueStreamForList('pending', {
        partition: 'validation',
        source: 'random_slice',
        inclusionProbability: 0.25,
      }),
    ).toEqual({ partition: null, source: null, inclusionProbability: null });
  });

  it('a resolved item carries the full stream — the record returns after judgment', () => {
    expect(
      discloseLabelQueueStreamForList('labeled', {
        partition: 'exemplar',
        source: 'judge_disagreement',
        inclusionProbability: null,
      }),
    ).toEqual({
      partition: 'exemplar',
      source: 'judge_disagreement',
      inclusionProbability: null,
    });
    expect(
      discloseLabelQueueStreamForList('dismissed', {
        partition: 'validation',
        source: 'random_slice',
        inclusionProbability: 0.25,
      }),
    ).toEqual({ partition: 'validation', source: 'random_slice', inclusionProbability: 0.25 });
  });
});

describe('rubricScopeKey', () => {
  it('keeps a suite rubric’s declared scope and namespaces the rest', () => {
    expect(rubricScopeKey({ kind: 'suite_criterion', criterionId: 'q', scopeKey: 'goal' })).toBe(
      'goal',
    );
    expect(rubricScopeKey({ kind: 'suite_criterion', criterionId: 'q' })).toBe('suite');
    const local = REVISIONS.get(REV_WITH_RUBRICS)!.case.rubrics[0]!;
    expect(rubricScopeKey(local)).toBe('case_local');
  });
});
