import { z } from 'zod';

/**
 * How long a rubric criterion may be — exported because the judge's answer
 * ECHOES it, and an echo tighter than its source makes the longest criteria
 * unjudgeable: the response fails validation and no alignment can match it.
 */
export const JUDGE_CRITERION_MAX_CHARS = 300;
import { EvalQualityReportSchema } from './evalQuality.js';
import { campaignParam, ThresholdOperatorSchema } from './campaignRef.js';

// ============================================================================
// Fault Layer
// ============================================================================

/** Classifies where a failure originated to drive correct remediation. */
export const FaultLayerSchema = z.enum([
  'platform', // Tool returned error, infrastructure failure, executor bug
  'configuration', // Wrong tools provided, bad context assembly, missing memory refs
  'agent', // Agent reasoned poorly given correct context and working tools
  'environment', // External API down, rate limited, data unavailable
]);
export type FaultLayer = z.infer<typeof FaultLayerSchema>;

// ============================================================================
// Eval Criterion — discriminated union across grading tiers
// ============================================================================

/**
 * Who authored a criterion. Absent ⇒ `'coach'` (back-compat: every persisted
 * criterion predates operator authoring). Drives the provenance badge and the
 * no-clobber ownership policy at apply time — the Coach may not edit/remove an
 * operator-authored criterion. Spread into every criterion variant.
 */
const criterionProvenance = {
  source: z.enum(['coach', 'operator']).optional(),
} as const;

// -- Tier 1: Deterministic --

export const ThresholdCriterionSchema = z.object({
  ...criterionProvenance,
  type: z.literal('threshold'),
  name: z.string().max(200),
  /** Metric key from task outputContract. */
  metric: z.string().max(128),
  operator: campaignParam(ThresholdOperatorSchema),
  target: campaignParam(z.number()),
  /** Upper bound when operator is 'between'. */
  targetHigh: z.number().optional(),
});
export type ThresholdCriterion = z.infer<typeof ThresholdCriterionSchema>;

export const MaterializedThresholdCriterionSchema = z.object({
  ...criterionProvenance,
  type: z.literal('threshold'),
  name: z.string().max(200),
  metric: z.string().max(128),
  operator: ThresholdOperatorSchema,
  target: z.number(),
  targetHigh: z.number().optional(),
});
export type MaterializedThresholdCriterion = z.infer<typeof MaterializedThresholdCriterionSchema>;

/** Checks that a field contains a pattern (regex or exact string). */
export const ContainsCriterionSchema = z.object({
  ...criterionProvenance,
  type: z.literal('contains'),
  name: z.string().max(200),
  /** Regex or exact string to match. */
  pattern: z.string().max(500),
  /** Which output field to check. */
  inField: z.string().max(128),
});
export type ContainsCriterion = z.infer<typeof ContainsCriterionSchema>;

// -- Tier 2: Trace metrics --

/** Checks that a trace-level metric stays within a bound. */
export const TraceBoundCriterionSchema = z.object({
  ...criterionProvenance,
  type: z.literal('trace_bound'),
  name: z.string().max(200),
  metric: z.enum(['step_count', 'duration_ms', 'cost_cents', 'token_count', 'tool_call_count']),
  maxValue: z.number(),
});
export type TraceBoundCriterion = z.infer<typeof TraceBoundCriterionSchema>;

// -- Tier 3: LLM-as-judge --

/** Structured rubric entry for LLM-as-judge evaluation. */
export const JudgeRubricEntrySchema = z.object({
  criterion: z.string().max(JUDGE_CRITERION_MAX_CHARS),
  scale: z.literal('binary'),
  description: z.string().max(500),
  /**
   * Read only by a decision-model judge, which answers each entry with a
   * calibrated probability: below this confidence the entry is `unclear`
   * rather than a pass or a fail. Absent, every answer commits. Part of the
   * rubric, so changing it changes the judge's version.
   */
  minConfidence: z.number().min(0).max(1).optional(),
});
export type JudgeRubricEntry = z.infer<typeof JudgeRubricEntrySchema>;

/**
 * What a judge criterion needs to see in order to answer.
 *
 * A judge asked to confirm a fact its evidence does not contain reads the
 * absence as a fabrication: correct answers were failed that way, repeatedly,
 * because the pack held tool JSON and not the reply, or the reply and not the
 * tool results. The criterion states its need so the stage can check the pack
 * BEFORE spending a model call, and abstain rather than guess when the need is
 * unmet.
 *
 * Each kind names a part of the pack the judge is actually given: `reply` the
 * subject's answer, `tool_result` what a named endpoint returned,
 * `task_summary` the run's task list. Kinds are added when a criterion needs
 * one — a selector nothing selects is a shape with no reader.
 */
export const JudgeEvidenceSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply') }),
  z.object({ kind: z.literal('tool_result'), endpointId: z.string().min(1).max(128) }),
  z.object({ kind: z.literal('task_summary') }),
]);
export type JudgeEvidenceSelector = z.infer<typeof JudgeEvidenceSelectorSchema>;

export const JudgeCriterionSchema = z.object({
  ...criterionProvenance,
  type: z.literal('judge'),
  name: z.string().max(200),
  rubric: z.array(JudgeRubricEntrySchema).min(1).max(5),
  /** Reference answer for reference-guided grading. */
  referenceAnswer: z.string().max(2000).optional(),
  /** Specific judge model override; uses suite default if omitted. */
  model: z.string().max(64).optional(),
  /**
   * What this criterion must be shown to answer. Empty means it reads whatever
   * the pack happens to carry, which is how a judge ends up guessing.
   */
  reads: z.array(JudgeEvidenceSelectorSchema).max(10).default([]),
});
export type JudgeCriterion = z.infer<typeof JudgeCriterionSchema>;

// -- Union --

/** A single evaluation criterion — one of the three grading tiers. */
export const EvalCriterionSchema = z.discriminatedUnion('type', [
  ThresholdCriterionSchema,
  ContainsCriterionSchema,
  TraceBoundCriterionSchema,
  JudgeCriterionSchema,
]);
export type EvalCriterion = z.infer<typeof EvalCriterionSchema>;

export type MaterializedEvalCriterion =
  Exclude<EvalCriterion, ThresholdCriterion> | MaterializedThresholdCriterion;

// ============================================================================
// Eval Suite — per-procedure evaluation definition
// ============================================================================

export const CyberneticEvalSuiteSchema = z.object({
  // NOTE: no procedureSlug field — derived from storage path (/evals/{slug}/suite.json).

  /**
   * Goal-level criteria (checked against run-level promoted metrics +
   * workflow outcomes). The goal tier is the steering tier — prefer
   * deterministic criteria (threshold / contains / trace_bound) here; a
   * judge-only goal tier with non-zero weight is rejected at authoring.
   */
  goalCriteria: z.array(EvalCriterionSchema).max(10).default([]),

  /** Task-level criteria keyed by taskId. */
  taskCriteria: z.record(z.string(), z.array(EvalCriterionSchema).max(10)).default({}),

  /** Trajectory criteria (checked against full execution trace). */
  trajectoryCriteria: z.array(EvalCriterionSchema).max(10).default([]),

  /**
   * Weights for computing overall score (should sum to 1.0). Discipline:
   * a tier whose criteria are ALL judge must carry weight 0 (advisory) —
   * an uncalibrated judge never carries the primary score.
   */
  weights: z
    .object({
      goal: z.number().min(0).max(1).default(0.4),
      task: z.number().min(0).max(1).default(0.4),
      trajectory: z.number().min(0).max(1).default(0.2),
    })
    .default({ goal: 0.4, task: 0.4, trajectory: 0.2 }),

  /**
   * Probability a judge criterion is dispatched on a run that didn't fail
   * (failed runs are always judged). The runner applies the default of 1;
   * a sampled-out criterion is recorded `not_selected` in the run's
   * evaluation envelope, never silently skipped.
   */
  judgeSamplingRate: z.number().min(0).max(1).optional(),

  /** ISO 8601 datetime when this suite was created. */
  createdAt: z.string().datetime(),
  /** ISO 8601 datetime when this suite was last updated. */
  updatedAt: z.string().datetime(),
  createdBy: z.string().max(64),
});
export type CyberneticEvalSuite = z.infer<typeof CyberneticEvalSuiteSchema>;

// ============================================================================
// Criterion Result — outcome of evaluating a single criterion
// ============================================================================

/** The result of evaluating a single criterion against a run. */
export const CriterionResultSchema = z.object({
  criterionName: z.string(),
  /** Criterion type discriminator ('threshold' | 'judge' | etc.). */
  criterionType: z.string(),
  passed: z.boolean(),
  /**
   * False when the criterion could not be APPLIED this run — its input was
   * absent (named field/metric not found, no trace metrics) or an unresolved
   * `$campaign` ref reached the grader. Such a result is still recorded (so
   * the defect is visible as advisory evidence) but is EXCLUDED from scoring:
   * a criterion that couldn't measure anything must never count as a 0/fail
   * and drag down an otherwise-valid run's score. Absent = applied (true).
   */
  applicable: z.boolean().optional(),
  score: z.number().min(0).max(1).optional(),
  /**
   * Raw measured value for numeric (`threshold`) criteria — the actual
   * metric the grader compared against the target (e.g. a Kaggle `lbValue`).
   * Lets surfaces plot the domain metric vs its target instead of parsing
   * the human-readable `evidence` string. Absent for non-numeric criteria.
   */
  observedValue: z.number().optional(),
  /** What was checked and what was found. */
  evidence: z.string().max(1000).optional(),
  /** LLM-as-judge rationale (Tier 3 only). */
  judgeRationale: z.string().max(1000).optional(),
});
export type CriterionResult = z.infer<typeof CriterionResultSchema>;

// ============================================================================
// Eval Result — canonical artifact produced by evaluation
// ============================================================================

/** The canonical eval artifact — immutable once produced. */
export const EvalResultSchema = z.object({
  id: z.string().uuid(),
  // procedureSlug derived from storage path, not stored in schema.
  runId: z.string().uuid(),
  sessionId: z.string().uuid(),

  /** Overall verdict. */
  verdict: z.enum(['pass', 'fail', 'partial', 'error']),

  /** Per-level results. */
  goalResults: z.array(CriterionResultSchema).default([]),
  taskResults: z.record(z.string(), z.array(CriterionResultSchema)).default({}),
  trajectoryResults: z.array(CriterionResultSchema).default([]),

  /** Fault classification (populated on failures). */
  faultLayer: FaultLayerSchema.optional(),
  faultEvidence: z.string().max(1000).optional(),

  /** Aggregate scores. */
  scores: z.object({
    goalScore: z.number().min(0).max(1).optional(),
    taskScore: z.number().min(0).max(1).optional(),
    trajectoryScore: z.number().min(0).max(1).optional(),
    overall: z.number().min(0).max(1),
  }),

  /** Confidence level of the evaluation. */
  confidence: z.enum(['high', 'medium', 'low']),

  /** Recommended owner for remediation. */
  suggestedRemediationOwner: z.enum(['learner', 'operator', 'platform_team', 'none']).optional(),

  /** ISO 8601 datetime when evaluation completed. */
  evaluatedAt: z.string().datetime(),
  /** How long the evaluation took. */
  evaluationDurationMs: z.number().int().nonnegative(),
  /** Cost of LLM-as-judge calls in cents. */
  evaluationCostCents: z.number().nonnegative().optional(),
});
export type EvalResult = z.infer<typeof EvalResultSchema>;

// ============================================================================
// Eval Baseline — rolling baseline for regression detection
// ============================================================================

// ============================================================================

// Forward-declared baseline schema is defined below; the bundle references it.

/** Rolling baseline scores for regression detection. */
export const EvalBaselineSchema = z.object({
  /** Score vector from the last N successful runs. */
  baselineScores: z.object({
    goalScore: z.number().min(0).max(1),
    taskScore: z.number().min(0).max(1),
    trajectoryScore: z.number().min(0).max(1),
    overall: z.number().min(0).max(1),
  }),
  /** How many runs contributed to this baseline. */
  sampleSize: z.number().int().positive(),
  /** ISO 8601 datetime when the baseline was last recalculated. */
  updatedAt: z.string().datetime(),
  /** Standard deviation of overall scores (for future statistical significance checks). */
  overallStddev: z.number().min(0).optional(),
  /** Alert when overall drops below baseline * (1 - threshold). */
  regressionThreshold: z.number().min(0).max(1).default(0.15),
  /** Consecutive breaches required before regression is confirmed. */
  consecutiveBreachesRequired: z.number().int().min(1).max(10).default(3),
  /** Current breach counter (reset on passing run). */
  currentBreachCount: z.number().int().nonnegative().default(0),
});
export type EvalBaseline = z.infer<typeof EvalBaselineSchema>;

/**
 * Aggregate payload returned by `GET /v1/spaces/:id/workflows/:slug/evals`.
 *
 * Bundles everything the Workflow Inspector's "Evals" tab needs in a single
 * round-trip: the suite definition, the rolling baseline, and a window of the
 * most recent results (newest first). Any field is null/empty when the
 * underlying memory doc doesn't exist yet — the inspector renders "no eval
 * data yet" placeholders rather than 404'ing.
 */
export const WorkflowEvalsBundleSchema = z.object({
  workflowSlug: z.string().min(1).max(128),
  suite: CyberneticEvalSuiteSchema.nullable(),
  baseline: EvalBaselineSchema.nullable(),
  /** Newest first; capped server-side (default: 20). */
  recentResults: z.array(EvalResultSchema),
  qualityReport: EvalQualityReportSchema.nullable(),
});

export type WorkflowEvalsBundle = z.infer<typeof WorkflowEvalsBundleSchema>;
