import { z } from 'zod';

// ============================================================================
// Scope
// ============================================================================

export const CoachLearningScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('campaign'),
      campaignId: z.string().uuid(),
      skillSlug: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal('skill'),
      skillSlug: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal('space'),
      spaceId: z.string().uuid(),
    })
    .strict(),
]);
export type CoachLearningScope = z.infer<typeof CoachLearningScopeSchema>;

// ============================================================================
// Kind
// ============================================================================

export const CoachLearningKindSchema = z.enum([
  'observation', // "X tended to correlate with Y in this campaign"
  'heuristic', // "when condition X, prefer approach Y"
  'constraint', // "approach Z consistently fails — avoid"
  'parameter_range', // "value in [a, b] worked; outside did not"
]);
export type CoachLearningKind = z.infer<typeof CoachLearningKindSchema>;

// ============================================================================
// Targeting
// ============================================================================

export const CoachLearningAppliesToSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('skill') }).strict(),
  z
    .object({
      kind: z.literal('tasks'),
      taskIds: z.array(z.string().min(1).max(120)).min(1).max(20),
    })
    .strict(),
]);
export type CoachLearningAppliesTo = z.infer<typeof CoachLearningAppliesToSchema>;

export const COACH_LEARNING_STATEMENT_MAX_CHARS = 800;
export const COACH_LEARNING_SUPERSEDES_MAX = 20;

// ============================================================================
// Top-level
// ============================================================================

export const CoachLearningSchema = z
  .object({
    /** Globally unique learning identifier (UUID v4). */
    learningId: z.string().uuid(),
    /** Coach session that emitted this learning. */
    coachSessionId: z.string().uuid(),
    /** Run that produced the evidence (optional — campaign-level summaries may omit). */
    runId: z.string().uuid().optional(),

    scope: CoachLearningScopeSchema,
    kind: CoachLearningKindSchema,

    appliesTo: CoachLearningAppliesToSchema.optional().describe(
      'Which workflow tasks this learning is for; absent = all tasks.',
    ),

    /** The learning itself — one sentence-to-paragraph claim. */
    statement: z.string().min(1).max(COACH_LEARNING_STATEMENT_MAX_CHARS),

    detailRef: z
      .string()
      .max(512)
      .optional()
      .describe(
        'Memory doc path with the full notes behind this learning; read it when the ' +
          'one-line statement is not enough.',
      ),

    evidence: z
      .object({
        digestRef: z.string().max(512).optional(),
        digestSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        citations: z
          .array(
            z
              .object({
                runId: z.string().uuid(),
                taskId: z.string().min(1).max(200).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(10),
      })
      .strict(),

    confidence: z.enum(['low', 'medium', 'high']),

    /** Older learning ids this record supersedes (sweep / merge). */
    supersedes: z.array(z.string().uuid()).max(COACH_LEARNING_SUPERSEDES_MAX).default([]),

    /**
     * Authority level — campaign-scope learnings can `auto_record` because
     * they don't mutate durable skill structure; skill- and space-scope
     * learnings `stage_for_review` like proposals do.
     */
    authorityLevel: z.enum(['auto_record', 'stage_for_review']).default('auto_record'),

    /**
     * Only `auto_recorded` and `ratified` inject into runs. Consolidation
     * transitions: `superseded` (merged into a survivor), `internalized`
     * (baked into skill structure), `retired` (stale), `disproven`
     * (contradicted by later evidence).
     */
    status: z
      .enum([
        'auto_recorded',
        'proposed',
        'ratified',
        'rejected',
        'internalized',
        'superseded',
        'retired',
        'disproven',
      ])
      .default('auto_recorded'),

    /** Set when an operator (or the ratify route) transitions status. */
    resolvedAt: z.string().datetime().optional(),
    resolvedBy: z.string().max(120).optional(),
    /** Why the status was transitioned (e.g. the disprove rationale). */
    resolutionNote: z.string().max(500).optional(),

    promotedFrom: z
      .object({
        campaignId: z.string().uuid().optional(),
        candidateLedgerEntryId: z.string().uuid(),
      })
      .strict()
      .optional(),

    createdAt: z.string().datetime(),
  })
  .strict();

export type CoachLearning = z.infer<typeof CoachLearningSchema>;
