/**
 * Batch rubric judging (P3, D8) — the pure decision layer: the subject
 * never grades itself (typed refusal naming the knob, never a silent pick),
 * deterministic fail short-circuits judges, suite sampling is recorded and
 * never silent, and the merge is advisory by construction — it cannot
 * change a deterministic verdict.
 */
import { describe, expect, it } from 'vitest';
import type { CaseRubric, CyberneticEvalSuite, JudgeCriterion } from '@aflow/schemas';
import { CyberneticEvalSuiteSchema, EvalCaseTrialResultsSchema } from '@aflow/schemas';
import {
  applyRubricResultsToTrialResults,
  deriveBatchJudgeVersions,
  deriveSubjectModels,
  dispatchCaseRubricJudge,
  planTrialRubricJudges,
  resolveJudgeModelForDispatch,
  resolveSuiteRubricCriterion,
  subjectModelRefsFromManifest,
} from '../evalBatchJudge.js';
import { computeJudgeVersion } from '../judgeVersion.js';
import { configureLogging } from '@aflow/observability';

configureLogging({ service: 'test', level: 'silent' });

function judgeCriterion(name: string, model?: string): JudgeCriterion {
  return {
    type: 'judge',
    name,
    rubric: [{ criterion: `${name} check`, scale: 'binary', description: `${name} description` }],
    ...(model !== undefined ? { model } : {}),
  };
}

function buildSuite(overrides: Partial<CyberneticEvalSuite> = {}): CyberneticEvalSuite {
  return CyberneticEvalSuiteSchema.parse({
    goalCriteria: [judgeCriterion('quality')],
    taskCriteria: { 'task-1': [judgeCriterion('output-quality')] },
    trajectoryCriteria: [judgeCriterion('efficiency')],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    createdBy: 'test',
    ...overrides,
  });
}

// ============================================================================
// Judge model rule (D8): subject ≠ judge
// ============================================================================

describe('resolveJudgeModelForDispatch', () => {
  const subjectModelRefs = ['subject-model'];

  it('resolves the space judge model when it differs from every subject model', () => {
    const resolution = resolveJudgeModelForDispatch({
      criterionModel: undefined,
      spaceJudgeModel: 'judge-model',
      subjectModelRefs,
    });
    expect(resolution).toEqual({ ok: true, model: 'judge-model' });
  });

  it('a criterion override wins over the space judge model', () => {
    const resolution = resolveJudgeModelForDispatch({
      criterionModel: 'override-model',
      spaceJudgeModel: 'subject-model',
      subjectModelRefs,
    });
    expect(resolution).toEqual({ ok: true, model: 'override-model' });
  });

  it('REFUSES when the space judge model equals the subject model — naming the knob', () => {
    const resolution = resolveJudgeModelForDispatch({
      criterionModel: undefined,
      spaceJudgeModel: 'subject-model',
      subjectModelRefs,
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.errorCode).toBe('judge_model_equals_subject');
    expect(resolution.errorMessage).toContain('modelDefaults.judge');
    expect(resolution.errorMessage).toContain('never silently picks');
  });

  it('REFUSES a criterion override equal to the subject model — naming the override', () => {
    const resolution = resolveJudgeModelForDispatch({
      criterionModel: 'subject-model',
      spaceJudgeModel: 'judge-model',
      subjectModelRefs,
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.errorCode).toBe('judge_model_equals_subject');
    expect(resolution.errorMessage).toContain("override ('model': 'subject-model')");
  });

  it('checks against EVERY subject model in the manifest, not just the first', () => {
    const resolution = resolveJudgeModelForDispatch({
      criterionModel: undefined,
      spaceJudgeModel: 'task-model',
      subjectModelRefs: ['runner-model', 'task-model'],
    });
    expect(resolution.ok).toBe(false);
  });
});

// ============================================================================
// Suite rubric resolution
// ============================================================================

describe('resolveSuiteRubricCriterion', () => {
  const suite = buildSuite();

  it('resolves by name across goal/task/trajectory scopes', () => {
    expect(resolveSuiteRubricCriterion(suite, 'quality', undefined)?.name).toBe('quality');
    expect(resolveSuiteRubricCriterion(suite, 'output-quality', 'task:task-1')?.name).toBe(
      'output-quality',
    );
    expect(resolveSuiteRubricCriterion(suite, 'efficiency', 'trajectory')?.name).toBe('efficiency');
  });

  it('a scopeKey mismatch resolves nothing (same-named criteria stay disambiguated)', () => {
    expect(resolveSuiteRubricCriterion(suite, 'quality', 'trajectory')).toBeNull();
    expect(resolveSuiteRubricCriterion(suite, 'output-quality', 'task:other-task')).toBeNull();
  });

  it('an unknown criterion resolves nothing', () => {
    expect(resolveSuiteRubricCriterion(suite, 'no-such-criterion', undefined)).toBeNull();
  });
});

// ============================================================================
// Per-trial plan
// ============================================================================

describe('planTrialRubricJudges', () => {
  const caseLocal: CaseRubric = { kind: 'case_local', criterion: judgeCriterion('local-quality') };
  const suiteRef: CaseRubric = {
    kind: 'suite_criterion',
    criterionId: 'quality',
    scopeKey: 'goal',
  };

  it('a trial that ERRORED skips every judge — there is no answer to read', () => {
    const plan = planTrialRubricJudges({
      rubrics: [caseLocal, suiteRef],
      suite: buildSuite(),
      deterministicVerdict: 'error',
    });
    expect(plan).toEqual([
      {
        action: 'skipped_run_error',
        criterionId: 'local-quality',
        scopeKey: 'case_local',
      },
      { action: 'skipped_run_error', criterionId: 'quality', scopeKey: 'goal' },
    ]);
  });

  it('a trial that FAILED a deterministic check is still judged', () => {
    // The reading a failure needs most: a deterministic check that fires on a
    // correct answer is indistinguishable from a correct check firing on a
    // wrong one, until something else reads the reply. The judge cannot promote
    // the fail, so this buys diagnosis at no risk to the verdict.
    const plan = planTrialRubricJudges({
      rubrics: [caseLocal],
      suite: null,
      deterministicVerdict: 'fail',
      random: () => 0.999,
    });
    expect(plan).toEqual([
      {
        action: 'judge',
        criterionId: 'local-quality',
        scopeKey: 'case_local',
        criterion: caseLocal.criterion,
      },
    ]);
  });

  it('a passing trial judges case_local rubrics unconditionally', () => {
    const plan = planTrialRubricJudges({
      rubrics: [caseLocal],
      suite: null,
      deterministicVerdict: 'pass',
      random: () => 0.999,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      action: 'judge',
      criterionId: 'local-quality',
      scopeKey: 'case_local',
    });
  });

  it('a suite_criterion rubric respects the suite judgeSamplingRate — sampled out is recorded, never silent', () => {
    const suite = buildSuite({ judgeSamplingRate: 0.5 });
    const sampledOut = planTrialRubricJudges({
      rubrics: [suiteRef],
      suite,
      deterministicVerdict: 'pass',
      random: () => 0.9,
    });
    expect(sampledOut).toEqual([
      { action: 'not_selected', criterionId: 'quality', scopeKey: 'goal' },
    ]);

    const sampledIn = planTrialRubricJudges({
      rubrics: [suiteRef],
      suite,
      deterministicVerdict: 'pass',
      random: () => 0.1,
    });
    expect(sampledIn[0]).toMatchObject({ action: 'judge', criterionId: 'quality' });
  });

  it('an unresolvable suite reference is typed unresolved, not dropped', () => {
    const noSuite = planTrialRubricJudges({
      rubrics: [suiteRef],
      suite: null,
      deterministicVerdict: 'pass',
    });
    expect(noSuite[0]).toMatchObject({
      action: 'unresolved',
      criterionId: 'quality',
      scopeKey: 'goal',
    });

    const wrongName = planTrialRubricJudges({
      rubrics: [{ kind: 'suite_criterion', criterionId: 'no-such' }],
      suite: buildSuite(),
      deterministicVerdict: 'pass',
    });
    expect(wrongName[0]).toMatchObject({
      action: 'unresolved',
      criterionId: 'no-such',
      scopeKey: 'suite',
    });
  });
});

// ============================================================================
// Advisory merge — provably never changes the verdict
// ============================================================================

describe('applyRubricResultsToTrialResults', () => {
  const baseResults = EvalCaseTrialResultsSchema.parse({
    expectationResults: [{ expectationIndex: 0, kind: 'terminal', passed: true }],
    fractionPassed: 1,
    fixtureTier: 'seeded',
    pendingRubrics: ['quality', 'local-quality'],
  });

  it('attaches rubric outcomes and drains resolved pending slots — deterministic fields untouched', () => {
    const merged = applyRubricResultsToTrialResults(baseResults, [
      {
        status: 'judged',
        criterionId: 'quality',
        scopeKey: 'goal',
        judgeVersion: 'v1',
        rationale: 'Meets the rubric.',
        verdict: 'fail',
        score: 0.2,
      },
    ]);
    expect(merged.expectationResults).toEqual(baseResults.expectationResults);
    expect(merged.fractionPassed).toBe(1);
    expect(merged.fixtureTier).toBe('seeded');
    expect(merged.pendingRubrics).toEqual(['local-quality']);
    expect(merged.rubricResults).toHaveLength(1);
  });

  it('a failing judge verdict cannot flip anything the trial verdict derives from (advisory)', () => {
    const merged = applyRubricResultsToTrialResults(baseResults, [
      {
        status: 'judged',
        criterionId: 'quality',
        scopeKey: 'goal',
        judgeVersion: 'v1',
        rationale: 'Bad.',
        verdict: 'fail',
        score: 0,
      },
      {
        status: 'error',
        criterionId: 'local-quality',
        scopeKey: 'case_local',
        errorCode: 'judge_dispatch_failed',
        errorMessage: 'provider down',
      },
    ]);
    // Every deterministic input to the trial verdict is byte-identical.
    expect(merged.expectationResults).toEqual(baseResults.expectationResults);
    expect(merged.fractionPassed).toBe(baseResults.fractionPassed);
    expect(merged.pendingRubrics).toEqual([]);
  });
});

// ============================================================================
// Dispatch — typed outcomes, never a thrown trial failure
// ============================================================================

describe('dispatchCaseRubricJudge', () => {
  const criterion = judgeCriterion('quality');
  const baseParams = {
    model: 'judge-model',
    criterionId: 'quality',
    scopeKey: 'goal',
    criterion,
    evidence: { taskSummaries: [] },
    tenantId: 'a0000000-0000-0000-0000-000000000001',
    runId: 'run-1',
  };

  it('records the verdict with the judgeVersion it was produced under (D9) and the call cost', async () => {
    const client = {
      generateJson: () =>
        Promise.resolve({
          data: {
            entries: [{ criterion: 'quality check', rationale: 'Meets rubric.', verdict: 'pass' }],
          },
          cost: { promptCost: 0.01, completionCost: 0.032, totalCost: 0.042, currency: 'USD' },
        }),
    } as never;
    const entry = await dispatchCaseRubricJudge({ ...baseParams, client });
    expect(entry.result).toEqual({
      status: 'judged',
      criterionId: 'quality',
      scopeKey: 'goal',
      judgeVersion: computeJudgeVersion(criterion.rubric, 'judge-model'),
      rationale: 'quality check — pass: Meets rubric.',
      verdict: 'pass',
      score: 1,
      entries: [{ criterion: 'quality check', rationale: 'Meets rubric.', verdict: 'pass' }],
    });
    expect(entry.costCents).toBeCloseTo(4.2, 10);
  });

  it('an unpriceable model costs 0 rather than blocking the verdict', async () => {
    const client = {
      generateJson: () =>
        Promise.resolve({
          data: {
            entries: [{ criterion: 'quality check', rationale: 'Meets rubric.', verdict: 'pass' }],
          },
        }),
    } as never;
    const entry = await dispatchCaseRubricJudge({ ...baseParams, client });
    expect(entry.result).toMatchObject({ status: 'judged' });
    expect(entry.costCents).toBe(0);
  });

  it('a dispatch failure becomes a typed error entry — it never throws (never fails the trial)', async () => {
    const client = {
      generateJson: () => Promise.reject(new Error('provider down')),
    } as never;
    const entry = await dispatchCaseRubricJudge({ ...baseParams, client });
    expect(entry.result).toMatchObject({
      status: 'error',
      criterionId: 'quality',
      scopeKey: 'goal',
      errorCode: 'judge_dispatch_failed',
      errorMessage: 'provider down',
    });
    expect(entry.costCents).toBe(0);
  });
});

// ============================================================================
// Launch-time provenance
// ============================================================================

describe('deriveBatchJudgeVersions', () => {
  it('keys suite refs by scope:criterionId and case-local rubrics by revision/name; omits unresolvable refs', () => {
    const suite = buildSuite();
    const local = judgeCriterion('local-quality');
    const versions = deriveBatchJudgeVersions({
      cases: [
        {
          revisionId: 'rev-1',
          rubrics: [
            { kind: 'suite_criterion', criterionId: 'quality', scopeKey: 'goal' },
            { kind: 'case_local', criterion: local },
          ],
        },
        {
          revisionId: 'rev-2',
          rubrics: [{ kind: 'suite_criterion', criterionId: 'no-such' }],
        },
      ],
      suite,
      spaceJudgeModel: 'judge-model',
    });

    expect(Object.keys(versions).sort()).toEqual(['goal:quality', 'rev-1/local-quality']);
    expect(versions['goal:quality']).toBe(
      computeJudgeVersion(
        suite.goalCriteria[0]!.type === 'judge' ? suite.goalCriteria[0].rubric : [],
        'judge-model',
      ),
    );
    expect(versions['rev-1/local-quality']).toBe(computeJudgeVersion(local.rubric, 'judge-model'));
  });

  it('same-named suite criteria at different scopes hold DISTINCT version keys', () => {
    const suite = buildSuite({
      goalCriteria: [judgeCriterion('quality')],
      trajectoryCriteria: [judgeCriterion('quality', 'override-model')],
    });
    const versions = deriveBatchJudgeVersions({
      cases: [
        {
          revisionId: 'rev-1',
          rubrics: [
            { kind: 'suite_criterion', criterionId: 'quality', scopeKey: 'goal' },
            { kind: 'suite_criterion', criterionId: 'quality', scopeKey: 'trajectory' },
          ],
        },
      ],
      suite,
      spaceJudgeModel: 'judge-model',
    });
    expect(Object.keys(versions).sort()).toEqual(['goal:quality', 'trajectory:quality']);
    expect(versions['goal:quality']).not.toBe(versions['trajectory:quality']);
  });

  it('a criterion model override participates in the version', () => {
    const local = judgeCriterion('local-quality', 'override-model');
    const versions = deriveBatchJudgeVersions({
      cases: [{ revisionId: 'rev-1', rubrics: [{ kind: 'case_local', criterion: local }] }],
      suite: null,
      spaceJudgeModel: 'judge-model',
    });
    expect(versions['rev-1/local-quality']).toBe(
      computeJudgeVersion(local.rubric, 'override-model'),
    );
  });
});

// ============================================================================
// Subject models
// ============================================================================

describe('deriveSubjectModels', () => {
  it('is the runner default plus every per-task override', () => {
    const models = deriveSubjectModels(
      [{ taskId: 't1', model: 'task-model' }, { taskId: 't2' }, { taskId: 't3', model: '' }],
      'runner-model',
      {},
    );
    expect(models).toEqual([
      { scope: 'runner', modelRef: 'runner-model' },
      { scope: 'task:t1', modelRef: 'task-model' },
    ]);
  });
});

describe('subjectModelRefsFromManifest', () => {
  it('extracts the refs from a valid manifest', () => {
    const refs = subjectModelRefsFromManifest({
      workflow: { slug: 'daily-metrics', revision: 1, configHash: 'hash' },
      dataset: { datasetId: '00000000-0000-4000-8000-0000000000d5', datasetVersion: 1 },
      subjectModels: [
        { scope: 'runner', modelRef: 'subject-a' },
        { scope: 'task:t1', modelRef: 'subject-b' },
      ],
      graderVersion: 'det-1',
    });
    expect(refs).toEqual(['subject-a', 'subject-b']);
  });

  it('is NULL (a refusal input) on an unparseable manifest — never an empty allow-list', () => {
    expect(subjectModelRefsFromManifest({ corrupted: true })).toBeNull();
    expect(subjectModelRefsFromManifest(null)).toBeNull();
    expect(subjectModelRefsFromManifest('garbage')).toBeNull();
  });
});
