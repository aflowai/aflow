import { z } from 'zod';
import { FailureCategorySchema } from './trajectoryDigest.js';
import { CoachObservationReasonSchema } from './coachObservation.js';
import { IssueCategorySchema } from './stagedChange.js';

// ============================================================================
// Sub-shapes
// ============================================================================

export const CoachFactsTaskFailureSchema = z
  .object({
    taskId: z.string().min(1).max(200),
    attempt: z.number().int().min(1),
    errorCategory: FailureCategorySchema,
    errorMessage: z.string().max(2000),
    /** How many of this same error shape occurred in this run. */
    repeatedShapeCount: z.number().int().min(1),
    stepExecutionId: z.string().uuid().optional(),
  })
  .strict();
export type CoachFactsTaskFailure = z.infer<typeof CoachFactsTaskFailureSchema>;

export const CoachFactsMissingInputSchema = z
  .object({
    taskId: z.string().min(1).max(200),
    inputKey: z.string().min(1).max(200),
    askedAt: z.string().datetime(),
    source: z.enum(['runner_reflection', 'tool_arg_validation', 'inferred']),
  })
  .strict();

export const CoachFactsMissingToolSchema = z
  .object({
    taskId: z.string().min(1).max(200),
    toolName: z.string().min(1).max(200),
    askedAt: z.string().datetime(),
    source: z.enum(['runner_reflection', 'inferred']),
  })
  .strict();

export const CoachFactsContractViolationSchema = z
  .object({
    taskId: z.string().min(1).max(200),
    kind: z.enum(['output_schema', 'output_root', 'port_compat', 'state_var_undeclared']),
    detail: z.string().max(500),
  })
  .strict();

export const CoachFactsDataflowBreakSchema = z
  .object({
    fromTaskId: z.string().min(1).max(200),
    toTaskId: z.string().min(1).max(200).optional(),
    detail: z.string().max(500),
  })
  .strict();

export const CoachFactsEvalDeltaSchema = z
  .object({
    /** Delta vs baseline; positive = improvement (when higher-is-better). */
    overall: z.number().optional(),
    perCriterion: z
      .array(
        z
          .object({
            criterionName: z.string().min(1).max(200),
            delta: z.number(),
            breached: z.boolean(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    regressionConfirmed: z.boolean(),
  })
  .strict();

export const CoachFactsCostLatencyAnomalySchema = z
  .object({
    metric: z.enum(['duration_ms', 'cost_cents', 'token_count']),
    taskId: z.string().min(1).max(200).optional(),
    value: z.number(),
    baselineMedian: z.number().optional(),
    stddevsAboveBaseline: z.number().optional(),
  })
  .strict();

export const CoachFactsPlatformEnvironmentSignalSchema = z
  .object({
    kind: z.enum([
      'provider_5xx',
      'capability_not_granted',
      'rate_limited',
      'binding_missing',
      'definition_not_found',
    ]),
    count: z.number().int().min(1),
    detail: z.string().max(500),
  })
  .strict();

export const CoachFactsRepeatedToolShapeSchema = z
  .object({
    operationId: z.string().min(1).max(200),
    /** Hash of normalized arg shape — stable across identical call shapes. */
    argShapeFingerprint: z.string().min(1).max(64),
    count: z.number().int().min(2),
    allSucceeded: z.boolean(),
    /** Phase 3b enrichment populates this; deterministic path leaves it undefined. */
    detail: z.string().max(300).optional(),
  })
  .strict();

export const CoachFactsPriorProposalSchema = z
  .object({
    proposalId: z.string().uuid(),
    status: z.enum(['ratified', 'rejected', 'expired', 'apply_failed']),
    issueCategory: IssueCategorySchema.optional(),
    summary: z.string().max(200),
    at: z.string().datetime(),
  })
  .strict();

export const CoachFactsObservationRollupSchema = z
  .object({
    reason: CoachObservationReasonSchema,
    count: z.number().int().min(1),
    firstSeen: z.string().datetime(),
    lastSeen: z.string().datetime(),
    sampleSummaries: z.array(z.string().max(200)).max(3).default([]),
  })
  .strict();

// ============================================================================
// Top-level envelope
// ============================================================================

export const CoachReviewFactsSchema = z
  .object({
    /** Globally unique facts identifier (UUID v4). */
    factsId: z.string().uuid(),
    /** Run the facts describe. */
    runId: z.string().uuid(),
    /** ISO 8601 — when the deterministic compiler finished. */
    compiledAt: z.string().datetime(),

    taskFailures: z.array(CoachFactsTaskFailureSchema).max(50).default([]),
    missingInputs: z.array(CoachFactsMissingInputSchema).max(50).default([]),
    missingTools: z.array(CoachFactsMissingToolSchema).max(50).default([]),
    contractViolations: z.array(CoachFactsContractViolationSchema).max(50).default([]),
    dataflowBreaks: z.array(CoachFactsDataflowBreakSchema).max(50).default([]),
    evalDeltas: CoachFactsEvalDeltaSchema.optional(),
    costLatencyAnomalies: z.array(CoachFactsCostLatencyAnomalySchema).max(50).default([]),
    platformEnvironmentSignals: z
      .array(CoachFactsPlatformEnvironmentSignalSchema)
      .max(50)
      .default([]),
    repeatedToolShapes: z.array(CoachFactsRepeatedToolShapeSchema).max(50).default([]),
    priorProposalHistory: z.array(CoachFactsPriorProposalSchema).max(20).default([]),
    priorObservationRollup: z.array(CoachFactsObservationRollupSchema).max(20).default([]),

    scopeSignal: z
      .object({
        kind: z.enum(['outcome_divergence', 'cluster_split', 'cluster_merge']),
        detail: z.string().max(500),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CoachReviewFacts = z.infer<typeof CoachReviewFactsSchema>;

// ============================================================================
// Storage path
// ============================================================================

export function coachReviewFactsDocPath(coachSessionId: string): string {
  return `/coach/facts/${coachSessionId}.json`;
}
