/**
 * Paired eval-batch comparison (Plan 269 D12). Pairing happens on the
 * intersection of IDENTICAL case revisions — an edited case is never paired
 * (a moved score must mean the skill moved, not the ruler) — and every
 * non-paired case is reported explicitly, never silently dropped. Intervals
 * are mandatory: a delta without its case-clustered bootstrap interval and
 * its n is not a finding.
 */
import { z } from 'zod';
import { GoldenCaseTierSchema } from './goldenCase.js';
import { EvalBatchProvenanceManifestSchema, EvalBatchStatusSchema } from './evalBatch.js';

// ============================================================================
// Sides
// ============================================================================

export const EvalBatchCompareSideSchema = z.object({
  batchId: z.string().uuid(),
  datasetVersion: z.number().int().nonnegative(),
  workflowRevision: z.number().int().nonnegative(),
  trialsPerCase: z.number().int().positive(),
  status: EvalBatchStatusSchema,
  /** The side's provenance manifest, when it recorded one. */
  manifest: EvalBatchProvenanceManifestSchema.optional(),
});
export type EvalBatchCompareSide = z.infer<typeof EvalBatchCompareSideSchema>;

/**
 * One dimension of the experiment, and whether it moved between the sides.
 *
 * `unknown` is a real answer and the common one: the manifest records
 * identities, so it can say a world changed without saying which handler, and
 * a side that predates a field cannot be compared on it at all. A comparison
 * that silently omitted those would read as "nothing else moved".
 */
export const EvalBatchDimensionChangeSchema = z.object({
  dimension: z.enum([
    'dataset',
    'case_content',
    'subject_graph',
    'subject_models',
    'agent_version',
    'api_contract',
    'simulated_world',
    'grader',
    'judges',
  ]),
  status: z.enum(['same', 'changed', 'unknown']),
  /** What is known about the difference, including why it is unknown. */
  detail: z.string().max(500),
});
export type EvalBatchDimensionChange = z.infer<typeof EvalBatchDimensionChangeSchema>;

// ============================================================================
// Deltas — always with uncertainty
// ============================================================================

/**
 * One metric's paired delta (B − A). The interval is a percentile bootstrap
 * CLUSTERED BY CASE (cases are resampled, trials ride with their case);
 * absent only when the paired set is empty.
 */
export const EvalBatchDeltaSchema = z.object({
  rateA: z.number().min(0).max(1),
  rateB: z.number().min(0).max(1),
  delta: z.number().min(-1).max(1),
  intervalLower: z.number().min(-1).max(1),
  intervalUpper: z.number().min(-1).max(1),
});
export type EvalBatchDelta = z.infer<typeof EvalBatchDeltaSchema>;

// ============================================================================
// Per-case flips
// ============================================================================

export const EvalBatchFlipDirectionSchema = z.enum(['pass_to_fail', 'fail_to_pass']);
export type EvalBatchFlipDirection = z.infer<typeof EvalBatchFlipDirectionSchema>;

/**
 * A paired case whose per-case success (every trial passed) flipped between
 * the batches. `finding: 'investigation'` (regression tier) carries the
 * trial runIds so the operator reads the transcripts — a flip NEVER
 * auto-verdicts (D12).
 */
export const EvalBatchFlipSchema = z.object({
  caseId: z.string().uuid(),
  caseRevisionId: z.string().uuid(),
  caseTitle: z.string().optional(),
  scenario: z.string(),
  tier: GoldenCaseTierSchema,
  direction: EvalBatchFlipDirectionSchema,
  /** Regression-tier flips demand transcript reading; capability-tier flips inform. */
  finding: z.enum(['investigation', 'informational']),
  passedTrialsA: z.number().int().nonnegative(),
  passedTrialsB: z.number().int().nonnegative(),
  /** Trial transcripts, ordered by trial index — the evidence for the investigation. */
  runIdsA: z.array(z.string()).max(20),
  runIdsB: z.array(z.string()).max(20),
});
export type EvalBatchFlip = z.infer<typeof EvalBatchFlipSchema>;

// ============================================================================
// Exclusions — listed, never silently dropped
// ============================================================================

export const EvalBatchExcludedCaseSchema = z.object({
  caseId: z.string().uuid(),
  caseRevisionId: z.string().uuid(),
  caseTitle: z.string().optional(),
});
export type EvalBatchExcludedCase = z.infer<typeof EvalBatchExcludedCaseSchema>;

export const EvalBatchEditedCaseSchema = z.object({
  caseId: z.string().uuid(),
  caseRevisionIdA: z.string().uuid(),
  caseRevisionIdB: z.string().uuid(),
  caseTitle: z.string().optional(),
});
export type EvalBatchEditedCase = z.infer<typeof EvalBatchEditedCaseSchema>;

/** A paired case one side never fully decided (cancelled/never-started/grader-error trials). */
export const EvalBatchUndecidedCaseSchema = z.object({
  caseId: z.string().uuid(),
  caseRevisionId: z.string().uuid(),
  caseTitle: z.string().optional(),
  decidedTrialsA: z.number().int().nonnegative(),
  decidedTrialsB: z.number().int().nonnegative(),
});
export type EvalBatchUndecidedCase = z.infer<typeof EvalBatchUndecidedCaseSchema>;

export const EvalBatchComparisonExclusionsSchema = z.object({
  /** Cases only in batch B (dataset grew between the batches). */
  added: z.array(EvalBatchExcludedCaseSchema).max(500),
  /** Cases only in batch A. */
  removed: z.array(EvalBatchExcludedCaseSchema).max(500),
  /** Same case, different revision — the ruler moved, so the pair is void. */
  edited: z.array(EvalBatchEditedCaseSchema).max(500),
  undecided: z.array(EvalBatchUndecidedCaseSchema).max(500),
  /** Member revisions whose golden-case rows are gone — unpairable, reported. */
  unresolvedRevisionIds: z.array(z.string().uuid()).max(500),
});
export type EvalBatchComparisonExclusions = z.infer<typeof EvalBatchComparisonExclusionsSchema>;

// ============================================================================
// The comparison
// ============================================================================

export const EvalBatchComparisonSchema = z.object({
  batchA: EvalBatchCompareSideSchema,
  batchB: EvalBatchCompareSideSchema,
  /**
   * What changed between the two runs, read before any delta. More than one
   * dimension moving is not a blocked comparison — it is a comparison that
   * cannot attribute, and the note says so.
   */
  changedDimensions: z.array(EvalBatchDimensionChangeSchema).max(20).default([]),
  /** Same dataset version on both sides is the happy path; false = intersection mechanics only. */
  identicalDatasetVersion: z.boolean(),
  /**
   * False when the sides ran different trials per case — pass^k and pass@k
   * then measure different bars (k moved), so only the per-trial pass rate
   * reads like-for-like.
   */
  identicalTrialsPerCase: z.boolean(),
  /** Paired cases fully decided on both sides — the n behind every delta. */
  pairedCases: z.number().int().nonnegative(),
  /** pass^k share delta over paired cases (every trial passed). */
  perCaseSuccess: EvalBatchDeltaSchema.optional(),
  /** pass@k share delta over paired cases (any trial passed). */
  passAny: EvalBatchDeltaSchema.optional(),
  /** Per-trial pass-rate delta over the paired cases' trials. */
  trialPass: EvalBatchDeltaSchema.optional(),
  /** Case-clustered percentile-bootstrap resamples behind the intervals; 0 when no interval was computable. */
  bootstrapResamples: z.number().int().nonnegative(),
  flips: z.array(EvalBatchFlipSchema).max(500),
  excluded: EvalBatchComparisonExclusionsSchema,
  /**
   * The mandatory statement of uncertainty: n, interval reading, exclusion
   * counts. Small paired sets say so here instead of manufacturing
   * certainty.
   */
  uncertaintyNote: z.string().max(2000),
});
export type EvalBatchComparison = z.infer<typeof EvalBatchComparisonSchema>;

// ============================================================================
// Capability → regression graduation flag (D12)
// ============================================================================

/**
 * A capability-tier case whose pass^k saturated across the last N
 * consecutive completed batches (N = `graduationConsecutiveBatches`). The
 * flag is a read-time derivation — the tier change itself stays an operator
 * case-edit; nothing auto-mutates.
 */
export const EvalGraduationCandidateSchema = z.object({
  caseId: z.string().uuid(),
  caseRevisionId: z.string().uuid(),
  caseTitle: z.string().optional(),
  scenario: z.string(),
  /** Consecutive completed batches with full pass^k, newest first. */
  batchIds: z.array(z.string().uuid()).max(50),
});
export type EvalGraduationCandidate = z.infer<typeof EvalGraduationCandidateSchema>;
