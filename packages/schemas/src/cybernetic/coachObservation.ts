import { z } from 'zod';

/**
 * Closed-set reason for emitting an observation. Drives Coach-health
 * aggregations (e.g. unknownAttributionRate is the share of reviews with
 * `reason === 'unattributable_failure'` over all reviews).
 */
export const CoachObservationReasonSchema = z.enum([
  'anomalous_metrics', // Run completed but metrics looked off (duration, cost, near-miss eval)
  'unattributable_failure', // Run failed but digest evidence didn't pin a category
  'context_pressure', // Budget pressure caused notable drops during digest assembly
  'cost_ceiling_suppressed', // Pre-flight estimate exceeded ceiling; review was suppressed
  'other', // Catch-all; requires non-empty `summary`
]);

export type CoachObservationReason = z.infer<typeof CoachObservationReasonSchema>;

/**
 * The CoachObservation record. One per review-without-proposal.
 */
export const CoachObservationSchema = z.object({
  observationId: z.string().uuid(),
  coachSessionId: z.string().uuid(),
  spaceId: z.string().uuid(),
  workflowSlug: z.string().min(1).max(128),
  /** The workflow run that triggered the review. */
  runId: z.string(),
  reason: CoachObservationReasonSchema,
  summary: z.string().min(1).max(500),
  detail: z.string().max(2000).optional(),
  /** Pointer to the persisted digest if one was assembled. */
  digestRef: z.string().max(512).optional(),
  digestSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  createdAt: z.string().datetime(),
});

export type CoachObservation = z.infer<typeof CoachObservationSchema>;
