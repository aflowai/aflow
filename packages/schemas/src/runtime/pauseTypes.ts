import { z } from 'zod';

// ============================================================================
// Pause Type Enum
// ============================================================================

export const PauseTypeSchema = z.enum([
  'user_input',
  'approval',
  'external_dependency',
  'budget_exceeded',
  'subflow_waiting',
  'guardrail_escalation',
  'external_callback',
  'interrupted',
  'oauth_consent',
  'invalid_decision',
]);
export type PauseType = z.infer<typeof PauseTypeSchema>;

// ============================================================================
// Resume Schema Descriptor
// ============================================================================

/**
 * Describes what input is needed to resume a paused run.
 * Wraps a JSON Schema so consumers know the shape of the expected resume payload.
 */
export const ResumeSchemaDescriptorSchema = z.object({
  /** JSON Schema describing the expected resume input */
  schema: z.record(z.unknown()),
  /** Human-readable description of what input is needed */
  description: z.string().max(2000).optional(),
});
export type ResumeSchemaDescriptor = z.infer<typeof ResumeSchemaDescriptorSchema>;

// ============================================================================
// Pause Metadata (unified payload for all pause types)
// ============================================================================

/**
 * Structured metadata about a pause event. Stored alongside the generic
 * `pauseReason` string for richer programmatic handling.
 */
export const PauseMetadataSchema = z.object({
  /** Categorized pause type */
  pauseType: PauseTypeSchema,

  /** Schema describing what input is needed to resume */
  resumeSchema: ResumeSchemaDescriptorSchema.optional(),

  /** Additional context specific to the pause type */
  context: z
    .object({
      /** Budget details (for budget_exceeded) */
      budgetExceededReason: z.string().optional(),
      /** Blocking category from subagent (for user_input with subagent) */
      blockingCategory: z.string().optional(),
      /** Guardrail violation details (for guardrail_escalation) */
      guardrailViolation: z.string().optional(),
    })
    .optional(),
});
export type PauseMetadata = z.infer<typeof PauseMetadataSchema>;
