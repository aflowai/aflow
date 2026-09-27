/**
 * Eval batch — one execution of (dataset version × skill revision × trials)
 * as a persisted state machine (Plan 269 D5/D17). The `eval_batches` and
 * `eval_case_results` rows ARE the state machine; these schemas type their
 * jsonb content: the frozen provenance manifest, the per-trial deterministic
 * grading record, and the terminal scorecard summary.
 */
import { z } from 'zod';

import { JudgeVerdictEntrySchema } from '../cybernetic/judgeVerdict.js';
import { ContextFixtureTierSchema } from './goldenCase.js';

// ============================================================================
// Batch lifecycle
// ============================================================================

export const EvalBatchStatusSchema = z.enum([
  'queued',
  'running',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
]);
export type EvalBatchStatus = z.infer<typeof EvalBatchStatusSchema>;

/**
 * Per-trial disposition (D17): a batch terminalizes deterministically even
 * when some trials never started — each carries a typed disposition.
 * `infra_retry`: the trial failed for infrastructure reasons and was
 * re-dispatched within budget (the failure is NOT a verdict on the case).
 */
export const EvalCaseResultDispositionSchema = z.enum([
  'scheduled',
  'running',
  'graded',
  'infra_retry',
  'cancelled',
  'never_started',
]);
export type EvalCaseResultDisposition = z.infer<typeof EvalCaseResultDispositionSchema>;

// ============================================================================
// Provenance manifest (D5)
// ============================================================================

/**
 * Effective agent model configuration a trial's runs execute under.
 * Judge calibration is scoped to this configuration (D11) — a manifest
 * lacking it makes two batches incomparable, so it is captured per batch.
 */
export const EvalBatchSubjectModelSchema = z.object({
  /** Which surface resolved this model (e.g. 'runner', or 'task:{taskId}'). */
  scope: z.string().min(1).max(200),
  /** Resolved model ref (catalog id) — provider derives from the catalog. */
  modelRef: z.string().min(1).max(200),
});
export type EvalBatchSubjectModel = z.infer<typeof EvalBatchSubjectModelSchema>;

/**
 * The frozen per-batch provenance manifest: what makes two batches
 * comparable, or explains why they are not. Without it a "skill comparison"
 * can silently be a model-default or tool-catalog comparison.
 */
/** Manifest key for a sealed case's source world. */
export function sealedSourceKey(caseRevisionId: string, simulationId: string): string {
  return `${caseRevisionId}/${simulationId}`;
}

export const EvalBatchProvenanceManifestSchema = z.object({
  workflow: z.object({
    slug: z.string().min(1).max(128),
    revision: z.number().int().nonnegative(),
    /** Hash of the materialized task graph + state variables actually run. */
    configHash: z.string().min(1).max(128),
  }),
  dataset: z.object({
    datasetId: z.string().uuid(),
    datasetVersion: z.number().int().nonnegative(),
  }),
  subjectModels: z.array(EvalBatchSubjectModelSchema).max(100).default([]),
  platform: z
    .object({
      /** Build/version identifier where cheaply available (e.g. git SHA / release tag). */
      buildVersion: z.string().max(200).optional(),
      nodeVersion: z.string().max(100).optional(),
    })
    .default({}),
  /** Version of the operation catalog / tool surface the trials resolved against. */
  catalogVersion: z.string().max(200).optional(),
  /** caseRevisionId → hash of the case's fixture content at launch. */
  caseFixtureHashes: z.record(z.string().min(1).max(128)).default({}),
  /**
   * caseRevisionId → hash of the case's DECIDING content: expectations,
   * rubrics and fixture together. `caseFixtureHashes` covers the fixture
   * alone, so an edited expectation changes what the batch measured while
   * leaving that hash identical.
   */
  caseContentHashes: z.record(z.string().min(1).max(128)).default({}),
  /**
   * Hash of the API definitions as the agent actually sees them — endpoint
   * names, descriptions and input schemas, the fields
   * `mapApiEndpointToToolSpec` builds a tool from.
   *
   * Changing an endpoint description to see whether the agent uses the tool
   * better is the experiment this product exists for, and nothing else in the
   * manifest records it: `catalogVersion` names the platform catalog, not
   * space-authored endpoints.
   */
  apiContractHash: z.string().min(1).max(128).optional(),
  /**
   * taskId → the agent version resolved at launch. Agent dispatch otherwise
   * takes `latest`, so an edit landing mid-batch gives two trials of one case
   * two different subjects under a single manifest.
   */
  agentVersions: z
    .record(z.object({ slug: z.string().min(1).max(200), version: z.string().min(1).max(200) }))
    .default({}),
  /**
   * The simulated world each sealed case was provisioned from, resolved ONCE
   * here and reused by every trial.
   *
   * A sealed trial copies its world out of the home space, and both halves of
   * that source are mutable: an operator can freeze a new baseline or edit the
   * artifact while the batch is still running. Resolving per trial would give
   * later trials of one case a different world than the first, under the same
   * case revision and the same seed — which is precisely the comparability the
   * tier exists to provide.
   *
   * Keyed `{caseRevisionId}/{simulationId}`.
   */
  sealedSources: z
    .record(
      z.object({
        simulationRevision: z.number().int().min(1),
        baselineVersion: z.number().int().min(1),
        /**
         * The API definition this source will copy into the trial's fixture
         * space, as it stood at launch. The copy happens at trial dispatch and
         * reads the home space THEN, so without this a definition edited
         * mid-batch is carried into the trial while the manifest still
         * describes the launch-time contract — and nothing reports the
         * difference.
         */
        definitionHash: z.string().min(1).max(128).optional(),
      }),
    )
    .default({}),
  /** Version of the deterministic grading implementation. */
  graderVersion: z.string().min(1).max(128),
  /**
   * Rubric slot → judgeVersion (D9 hash), keyed `{scopeKey}:{criterionId}`
   * for suite refs and `{caseRevisionId}/{name}` for case-local rubrics
   * (`manifestJudgeVersionKey`) — same-named criteria at different scopes
   * hold distinct versions.
   */
  judgeVersions: z.record(z.string().min(1).max(200)).default({}),
});
export type EvalBatchProvenanceManifest = z.infer<typeof EvalBatchProvenanceManifestSchema>;

// ============================================================================
// Per-trial deterministic grading record (D3/D6)
// ============================================================================

/** One expectation's binary outcome; `detail` explains a failure legibly. */
export const ExpectationResultSchema = z.object({
  /** Index into the case revision's `expectations` array. */
  expectationIndex: z.number().int().nonnegative(),
  kind: z.enum(['terminal', 'task_status', 'output', 'reply', 'trajectory', 'simulation']),
  passed: z.boolean(),
  detail: z.string().max(2000).optional(),
});
export type ExpectationResult = z.infer<typeof ExpectationResultSchema>;

/**
 * Trial verdict: deterministic expectations decide it — a trial whose
 * deterministic expectations fail is `fail` regardless of judge scores
 * (judge scores are noise on a contract-failed run). `error` marks a trial
 * the grader itself could not decide (grading fault, not case fault).
 */
export const EvalCaseTrialVerdictSchema = z.enum(['pass', 'fail', 'error']);
export type EvalCaseTrialVerdict = z.infer<typeof EvalCaseTrialVerdictSchema>;

// ============================================================================
// Per-trial rubric (judge) results — ADVISORY (D8/D11)
// ============================================================================

export const EvalRubricJudgeErrorCodeSchema = z.enum([
  /** Resolved judge model equals the subject run's agent model (D8 bias rule). */
  'judge_model_equals_subject',
  /** The judge LLM call failed (provider, parse, timeout). */
  'judge_dispatch_failed',
  /** No BYOK credential resolves for the judge model's provider. */
  'judge_client_unavailable',
  /** A suite_criterion rubric names a criterion the production suite does not have. */
  'rubric_criterion_unresolved',
  /**
   * The pack does not hold what the criterion declared it reads. Asking anyway
   * buys a verdict on absent evidence, and a judge reads absence as invention.
   */
  'evidence_unavailable',
  /**
   * The batch's provenance manifest would not parse, so the subject models
   * are unknown and the judge≠subject rule cannot be checked — the dispatch
   * fails closed instead of running an unchecked judge.
   */
  'manifest_unavailable',
]);
export type EvalRubricJudgeErrorCode = z.infer<typeof EvalRubricJudgeErrorCodeSchema>;

/**
 * One rubric slot's outcome for a trial. ADVISORY throughout: no status here
 * ever changes the trial's deterministic verdict or any pass metric — the
 * scorecard reports these in a separate advisory section. A slot's identity
 * is `(criterionId, scopeKey)` — same-named criteria at different scopes are
 * different judges, so every outcome carries both.
 */
export const EvalCaseRubricResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('judged'),
    /**
     * The judge's answer to each rubric entry. The rolled-up verdict and score
     * are derived from these, so a reader never has to parse a paragraph to
     * learn which criterion failed, and a label can be attached to one claim.
     */
    entries: z.array(JudgeVerdictEntrySchema).max(5).optional(),
    criterionId: z.string().min(1).max(300),
    /** 'goal' | 'trajectory' | 'task:{taskId}' | 'suite' | 'case_local'. */
    scopeKey: z.string().min(1).max(300),
    /** D9 hash the verdict was produced under (rubric + judge model + prompt template). */
    judgeVersion: z.string().min(1).max(200),
    rationale: z.string().max(1500),
    verdict: z.enum(['pass', 'fail', 'unclear']),
    score: z.number().min(0).max(1),
  }),
  z.object({
    status: z.literal('error'),
    criterionId: z.string().min(1).max(300),
    scopeKey: z.string().min(1).max(300),
    errorCode: EvalRubricJudgeErrorCodeSchema,
    errorMessage: z.string().max(2000),
    judgeVersion: z.string().min(1).max(200).optional(),
  }),
  /** Sampled out by the suite's judgeSamplingRate — recorded, never silent. */
  z.object({
    status: z.literal('not_selected'),
    criterionId: z.string().min(1).max(300),
    scopeKey: z.string().min(1).max(300),
  }),
  /**
   * The trial produced no usable answer to judge — it errored rather than
   * failing a check. A failed check is judged like any other trial: the judge
   * cannot promote a fail, and a failure is where a second reading is worth
   * most, because the deterministic check itself may be the thing at fault.
   */
  z.object({
    status: z.literal('skipped_run_error'),
    criterionId: z.string().min(1).max(300),
    scopeKey: z.string().min(1).max(300),
  }),
]);
export type EvalCaseRubricResult = z.infer<typeof EvalCaseRubricResultSchema>;

export const EvalCaseTrialResultsSchema = z.object({
  expectationResults: z.array(ExpectationResultSchema).max(50).default([]),
  /** Fraction of binary expectations passed (partial credit, D3). */
  /**
   * Share of deterministic checks that passed. Absent on a case that carries
   * none — a rubric-only case has no fraction, and reporting 0 or 1 would read
   * as a measurement nobody made.
   */
  fractionPassed: z.number().min(0).max(1).optional(),
  fixtureTier: ContextFixtureTierSchema,
  /**
   * Whether the trial's run reported a cost at all. A trial that spent
   * nothing and a trial whose spend was never recorded both land 0 in
   * `costCents`, and only this flag separates them — without it a batch
   * reports `costSpentCents: 0` and reads as free when it is merely
   * unmeasured, which would also make the cost ceiling look enforced
   * when it cannot fire.
   */
  costObserved: z.boolean().default(true),
  /**
   * Rubric slots the judge stage has not resolved into `rubricResults`.
   * The deterministic grader records every rubric here; the judge stage of
   * the same grading pass drains them. Non-empty on a persisted row means
   * the judge stage could not run at all.
   */
  pendingRubrics: z.array(z.string().min(1).max(300)).max(10).default([]),
  /**
   * ADVISORY judge outcomes per rubric slot — they never change `verdict`,
   * `fractionPassed`, or any scorecard pass metric.
   */
  rubricResults: z.array(EvalCaseRubricResultSchema).max(10).default([]),
  /** The run's typed failure, attached when the trial run terminated failed. */
  runFailure: z
    .object({
      runStatus: z.enum(['completed', 'paused', 'failed', 'cancelled']),
      failureReason: z.string().max(2000).optional(),
    })
    .optional(),
  /** Set when verdict is 'error' — why the grader could not decide. */
  gradingError: z.string().max(2000).optional(),
});
export type EvalCaseTrialResults = z.infer<typeof EvalCaseTrialResultsSchema>;

// ============================================================================
// Batch scorecard summary (terminal jsonb on eval_batches)
// ============================================================================

export const EvalBatchStratumScoreSchema = z.object({
  scenario: z.string().min(1).max(200),
  tier: z.enum(['regression', 'capability']),
  cases: z.number().int().nonnegative(),
  /** Fraction of trials passing across the stratum. */
  passRate: z.number().min(0).max(1),
  /** Fraction of fully-graded cases where ALL trials passed (pass^k). */
  passAllTrialsRate: z.number().min(0).max(1),
  /** Fraction of cases where at least one trial passed (pass@k). */
  passAnyTrialRate: z.number().min(0).max(1),
});
export type EvalBatchStratumScore = z.infer<typeof EvalBatchStratumScoreSchema>;

/**
 * Per-criterion advisory judge aggregate (D8/D11): informs the operator,
 * never gates — the deterministic verdict fields on the summary are the
 * only pass metrics.
 */
export const EvalBatchAdvisoryJudgeScoreSchema = z.object({
  criterionId: z.string().min(1).max(300),
  /** Slot scope — same-named criteria at different scopes aggregate separately. */
  scopeKey: z.string().min(1).max(300),
  /** Set when every judged trial carried the same D9 version (the frozen-batch norm). */
  judgeVersion: z.string().min(1).max(200).optional(),
  judgedTrials: z.number().int().nonnegative(),
  passedTrials: z.number().int().nonnegative(),
  /** Fraction of judged trials the judge passed — advisory only. */
  passShare: z.number().min(0).max(1).optional(),
  errorTrials: z.number().int().nonnegative(),
  notSelectedTrials: z.number().int().nonnegative(),
  skippedDeterministicFailTrials: z.number().int().nonnegative(),
});
export type EvalBatchAdvisoryJudgeScore = z.infer<typeof EvalBatchAdvisoryJudgeScoreSchema>;

export const EvalBatchSummarySchema = z.object({
  cases: z.number().int().nonnegative(),
  trialsPerCase: z.number().int().positive(),
  dispositions: z.record(EvalCaseResultDispositionSchema, z.number().int().nonnegative()),
  verdicts: z.record(EvalCaseTrialVerdictSchema, z.number().int().nonnegative()),
  /**
   * Trials carrying a behavioural claim — the denominator of `passRate`.
   * A trial excluded for execution, setup or missing evidence is counted in
   * `excludedTrials` instead, so infrastructure never depresses the score and
   * an exclusion is never invisible.
   */
  scoredTrials: z.number().int().nonnegative().default(0),
  excludedTrials: z
    .object({
      invalid_case: z.number().int().nonnegative(),
      execution_error: z.number().int().nonnegative(),
      incomplete_evidence: z.number().int().nonnegative(),
    })
    .default({ invalid_case: 0, execution_error: 0, incomplete_evidence: 0 }),
  /** Share of terminal trials that failed to execute — reported beside the score, never inside it. */
  executionFailureRate: z.number().min(0).max(1).optional(),
  /** Fraction of SCORED trials that passed. */
  passRate: z.number().min(0).max(1).optional(),
  /** Fraction of cases with every configured trial SCORED where all passed (pass^k). */
  passAllTrialsRate: z.number().min(0).max(1).optional(),
  /** Fraction of cases where at least one graded trial passed (pass@k). */
  passAnyTrialRate: z.number().min(0).max(1).optional(),
  /** Fraction of graded trials decided with zero judge calls. */
  zeroJudgeShare: z.number().min(0).max(1).optional(),
  strata: z.array(EvalBatchStratumScoreSchema).max(200).default([]),
  /**
   * ADVISORY judge section, clearly separate from the deterministic verdict
   * metrics above: per-criterion pass shares that inform and never gate.
   */
  advisoryJudgeCriteria: z.array(EvalBatchAdvisoryJudgeScoreSchema).max(200).default([]),
  costSpentCents: z.number().int().nonnegative(),
  /**
   * Graded trials whose run reported no cost. Non-zero means
   * `costSpentCents` UNDER-reports actual spend and the cost ceiling had
   * nothing to enforce against — a reader must not take 0¢ for free.
   */
  costUnobservedTrials: z.number().int().nonnegative().default(0),
  /** Set when the batch terminalized abnormally (cost ceiling, cancellation, engine fault). */
  terminalReason: z.string().max(2000).optional(),
});
export type EvalBatchSummary = z.infer<typeof EvalBatchSummarySchema>;
