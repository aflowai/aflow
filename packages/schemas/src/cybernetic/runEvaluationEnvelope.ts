import { z } from 'zod';
import { FaultLayerSchema } from './eval.js';

/**
 * Typed contents of `workflow_runs.evaluation_json` — one envelope per run,
 * written only through the single writer (`writeRunEvaluationEnvelope` in
 * `@aflow/cybernetic-runtime`). Records both WHAT the post-run evaluation
 * decided and WHY it did or didn't run, so "did eval fire" is a read, not a
 * code-reading exercise.
 */

/**
 * Why deterministic evaluation did or didn't run on a terminal run.
 * `eval_batch`: the run is a frozen eval-batch trial (`workflow_runs.
 * eval_batch_id` set) — production-suite evaluation is skipped in favor of
 * batch grading, whose verdicts live in `eval_case_results`, not here.
 */
export const RunEvaluationDecisionSchema = z.enum([
  'ran',
  'no_suite',
  'operator_cancelled',
  'no_scorable_criteria',
  'eval_batch',
  'error',
]);
export type RunEvaluationDecision = z.infer<typeof RunEvaluationDecisionSchema>;

/** The eval-result summary the Runs surfaces read (score + verdict chips). */
export const RunEvaluationSummarySchema = z.object({
  verdict: z.enum(['pass', 'fail', 'partial', 'error']),
  scores: z.object({
    goalScore: z.number().min(0).max(1).optional(),
    taskScore: z.number().min(0).max(1).optional(),
    trajectoryScore: z.number().min(0).max(1).optional(),
    overall: z.number().min(0).max(1),
  }),
  faultLayer: FaultLayerSchema.nullable(),
  regressionDetected: z.boolean(),
});
export type RunEvaluationSummary = z.infer<typeof RunEvaluationSummarySchema>;

/**
 * Per-judge-criterion dispatch record. A criterion sampled out by
 * `judgeSamplingRate` is `not_selected` — excluded from scoring but never
 * silent. Failed runs are always judged, so `not_selected` only appears on
 * non-failed runs.
 */
export const JudgeCriterionSelectionSchema = z.object({
  scope: z.enum(['goal', 'task', 'trajectory']),
  taskId: z.string().optional(),
  criterionName: z.string(),
  selection: z.enum(['evaluated', 'not_selected']),
});
export type JudgeCriterionSelection = z.infer<typeof JudgeCriterionSelectionSchema>;

export const RunOutcomeResultSchema = z.object({
  outcomeId: z.string(),
  met: z.boolean(),
  value: z.unknown(),
  detail: z.string().max(500).optional(),
});
export type RunOutcomeResult = z.infer<typeof RunOutcomeResultSchema>;

/** `workflow.evaluate` outcome results — a distinct slot, never merged into `summary`. */
export const RunOutcomeEvaluationSchema = z.object({
  outcomeResults: z.array(RunOutcomeResultSchema),
  allMet: z.boolean(),
});
export type RunOutcomeEvaluation = z.infer<typeof RunOutcomeEvaluationSchema>;

/**
 * Plan 341 D2 — the arms one benchmark task is attempted under: the bare
 * coding harness, the loop, and the loop with learnings and memory on.
 */
export const BenchmarkArmSchema = z.enum(['bare_harness', 'loop', 'loop_with_learning']);
export type BenchmarkArm = z.infer<typeof BenchmarkArmSchema>;

/**
 * Why a benchmark attempt did not pass. `tests_failed` is the official
 * harness's verdict. `image_unavailable` and `harness_error` mean the harness
 * gave no verdict, so the attempt is unscored rather than failed.
 */
export const BenchmarkFailureClassSchema = z.enum([
  'materialize_failed',
  'agent_failed',
  'agent_timeout',
  'empty_patch',
  'image_unavailable',
  'harness_error',
  'tests_failed',
]);
export type BenchmarkFailureClass = z.infer<typeof BenchmarkFailureClassSchema>;

/**
 * Plan 341 D6 — one benchmark task attempt as its official harness graded it.
 * `passed` is the harness's hidden-test verdict and nothing else: no judge
 * scores a benchmark task.
 */
export const BenchmarkAttemptResultSchema = z.object({
  benchmark: z.literal('swe-bench-pro'),
  instanceId: z.string().min(1),
  arm: BenchmarkArmSchema,
  passed: z.boolean(),
  failureClass: BenchmarkFailureClassSchema.nullable(),
  /** Model tokens the attempt spent; null where the agent reported none. */
  tokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  wallTimeMs: z.number().int().nonnegative(),
  patchBytes: z.number().int().nonnegative(),
  /** The official harness checkout's revision the verdict came from. */
  harnessRevision: z.string().min(1),
  detail: z.string().max(8000).optional(),
});
export type BenchmarkAttemptResult = z.infer<typeof BenchmarkAttemptResultSchema>;

export const RunEvaluationEnvelopeSchema = z.object({
  /**
   * Present on every terminal run (the post-run hook always writes it,
   * including `operator_cancelled` and `no_suite`). Absent only transiently
   * when `workflow.evaluate` records outcomes while the run is still active.
   */
  decision: RunEvaluationDecisionSchema.optional(),
  decidedAt: z.string().datetime().optional(),
  /** Hash of the suite content that ran; omitted when no suite. */
  suiteContentHash: z.string().optional(),
  /** Present when decision = 'ran'. */
  summary: RunEvaluationSummarySchema.optional(),
  judgeSelection: z.array(JudgeCriterionSelectionSchema).optional(),
  outcomeEvaluation: RunOutcomeEvaluationSchema.optional(),
  /** Present on a benchmark task attempt (Plan 341 D6). */
  benchmark: BenchmarkAttemptResultSchema.optional(),
  /** Present when decision = 'error'. */
  errorMessage: z.string().optional(),
});
export type RunEvaluationEnvelope = z.infer<typeof RunEvaluationEnvelopeSchema>;
