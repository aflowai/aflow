import { z } from 'zod';

// ============================================================================
// Bucket Duration
// ============================================================================

/** Supported rollup levels for entity metrics. */
export const EntityMetricsBucketDurationSchema = z.enum(['1h', '1d', '7d']);

export type EntityMetricsBucketDuration = z.infer<typeof EntityMetricsBucketDurationSchema>;

// ============================================================================
// Mode Distribution
// ============================================================================

/** Fraction of triggers by operating mode within a bucket. */
export const EntityModeDistributionSchema = z.object({
  conversational: z.number().nonnegative(),
  exploratory: z.number().nonnegative(),
  procedural: z.number().nonnegative(),
  supervisory: z.number().nonnegative(),
});

export type EntityModeDistribution = z.infer<typeof EntityModeDistributionSchema>;

// ============================================================================
// Entity Metrics Bucket
// ============================================================================

/**
 * Aggregated metrics for a single time bucket within a space.
 *
 * Each bucket covers a fixed duration starting at `bucketStart`.
 * Fields are grouped by category: activity, mode distribution, cost,
 * competence signals, and evaluation signals.
 */
export const EntityMetricsBucketSchema = z.object({
  /** Space these metrics belong to. */
  spaceId: z.string().uuid(),

  /** Tenant these metrics belong to. */
  tenantId: z.string(),

  /** ISO 8601 datetime marking the start of this bucket. */
  bucketStart: z.string().datetime(),

  /** Rollup level. */
  bucketDuration: EntityMetricsBucketDurationSchema,

  // ── Activity ────────────────────────────────────────────────────────────

  /** Number of triggers received in this bucket. */
  triggerCount: z.number().int().nonnegative(),

  /** Number of user interactions in this bucket. */
  interactionCount: z.number().int().nonnegative(),

  /** Number of procedure activations in this bucket. */
  procedureActivationCount: z.number().int().nonnegative(),

  /** Number of Runner sessions dispatched in this bucket. */
  runnerSessionCount: z.number().int().nonnegative(),

  /** Number of background (non-interactive) runs in this bucket. */
  backgroundRunCount: z.number().int().nonnegative(),

  // ── Mode distribution ───────────────────────────────────────────────────

  /** Fraction of triggers by operating mode. */
  modeDistribution: EntityModeDistributionSchema,

  // ── Cost ────────────────────────────────────────────────────────────────

  /** Total cost in USD for this bucket. */
  totalCostUsd: z.number().nonnegative(),

  /** Total tokens consumed in this bucket. */
  totalTokens: z.number().int().nonnegative(),

  // ── Competence signals ──────────────────────────────────────────────────

  /** Fraction of procedure runs that succeeded (0–1). */
  procedureSuccessRate: z.number().min(0).max(1).optional(),

  /** Average procedure run duration in milliseconds. */
  averageProcedureDurationMs: z.number().nonnegative().optional(),

  /** Number of Coach proposals in this bucket. */
  coachProposalCount: z.number().int().nonnegative(),

  /** Number of ratified Coach proposals in this bucket. */
  coachRatifiedCount: z.number().int().nonnegative(),

  /** Number of rejected Coach proposals in this bucket. */
  coachRejectedCount: z.number().int().nonnegative(),

  /** Number of anomalies detected in this bucket. */
  anomalyCount: z.number().int().nonnegative(),

  // ── Evaluation signals (from 102f) ──────────────────────────────────────

  /** Fraction of eval runs that passed (0–1). */
  evalPassRate: z.number().min(0).max(1).optional(),

  /** Number of confirmed regressions in this bucket. */
  evalRegressionCount: z.number().int().nonnegative().optional(),

  /** Mean overall eval score (0–1). */
  averageEvalScore: z.number().min(0).max(1).optional(),

  /** Number of pruned learning items in this bucket. */
  prunedLearningCount: z.number().int().nonnegative(),
});

export type EntityMetricsBucket = z.infer<typeof EntityMetricsBucketSchema>;
