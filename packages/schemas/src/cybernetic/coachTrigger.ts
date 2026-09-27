import { z } from 'zod';

// ============================================================================
// Coach Trigger Kind
// ============================================================================

/** What kind of event is activating the Coach. */
export const CoachTriggerKindSchema = z.enum([
  'run_completed', // A Workflow Run reached terminal state
  'interaction_ended', // A user interaction session ended
  'scheduled_review', // Periodic background review (cron-based)
  'scarcity_sweep', // Budget/decay enforcement cycle
  'manual', // Operator-triggered review
]);

export type CoachTriggerKind = z.infer<typeof CoachTriggerKindSchema>;

// ============================================================================
// Coach Trigger Schema
// ============================================================================

/**
 * Typed trigger envelope for Coach activation.
 * The Coach reads this to understand what it should review and why.
 */
export const CoachTriggerSchema = z.object({
  /** What kind of event triggered this activation. */
  kind: CoachTriggerKindSchema,

  /** Space containing the entity. */
  spaceId: z.string().uuid(),

  /** Tenant owning the space. */
  tenantId: z.string(),

  /** Source session (for run_completed, interaction_ended). */
  sourceSessionId: z.string().uuid().optional(),

  /** Source workflow slug (for run_completed). */
  sourceWorkflowSlug: z.string().optional(),

  /** Source run ID (for run_completed). */
  sourceRunId: z.string().uuid().optional(),

  /** Review scope -- what the Coach should focus on. */
  reviewScope: z
    .object({
      /** Specific session IDs to review. */
      sessionIds: z.array(z.string().uuid()).optional(),
      /** Specific workflow slugs to review. */
      workflowSlugs: z.array(z.string()).optional(),
      /** Time range for review (epoch milliseconds). */
      timeRangeMs: z
        .object({
          from: z.number(),
          to: z.number(),
        })
        .optional(),
    })
    .optional(),

  /** Priority (higher = process sooner). */
  priority: z.enum(['low', 'normal', 'high']).default('normal'),

  /** When this trigger was created (ISO 8601). */
  triggeredAt: z.string().datetime(),
});

export type CoachTrigger = z.infer<typeof CoachTriggerSchema>;
