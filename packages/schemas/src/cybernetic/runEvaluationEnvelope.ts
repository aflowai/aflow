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
  /** Present when decision = 'error'. */
  errorMessage: z.string().optional(),
});
export type RunEvaluationEnvelope = z.infer<typeof RunEvaluationEnvelopeSchema>;
