import { z } from 'zod';
import { WorkflowLearningCategorySchema } from '../operations/workflow/enums.js';
import { WORKFLOW_LEARNING_TEXT_MAX_CHARS } from '../operations/workflow/learning.js';
import { CoachLearningKindSchema, COACH_LEARNING_STATEMENT_MAX_CHARS } from './coachLearning.js';

// ============================================================================
// Active learning set — the one read authority's typed output
// ============================================================================

/**
 * The campaign frame candidates are read against — objective, peak, recent
 * series. Not a learning; never truncated and never counted against the
 * injection budget.
 */
export const ActiveTrajectoryLearningSchema = z
  .object({
    kind: z.literal('trajectory'),
    objective: z
      .object({
        metricKey: z.string().min(1).max(128),
        direction: z.enum(['maximize', 'minimize']),
      })
      .strict(),
    peak: z.number().optional(),
    recentScores: z.array(z.number()).max(20),
  })
  .strict();

/** A durable `CoachLearning` (auto-recorded or operator-ratified). */
export const ActiveDurableLearningSchema = z
  .object({
    kind: z.literal('durable'),
    learningId: z.string().uuid(),
    statement: z.string().min(1).max(COACH_LEARNING_STATEMENT_MAX_CHARS),
    learningKind: CoachLearningKindSchema,
    confidence: z.enum(['low', 'medium', 'high']),
    scopeKind: z.enum(['campaign', 'skill', 'space']),
    detailRef: z
      .string()
      .max(512)
      .optional()
      .describe(
        'Memory doc path with the full notes behind this learning; read it when the ' +
          'one-line statement is not enough.',
      ),
  })
  .strict();

/** A pending fast-inject candidate — a hypothesis, co-read with the trajectory. */
export const ActiveCandidateLearningSchema = z
  .object({
    kind: z.literal('candidate'),
    runId: z.string().min(1).max(128),
    learningId: z.string().min(1).max(64),
    category: WorkflowLearningCategorySchema,
    observation: z.string().min(1).max(WORKFLOW_LEARNING_TEXT_MAX_CHARS),
    recommendation: z.string().max(WORKFLOW_LEARNING_TEXT_MAX_CHARS).optional(),
    confidence: z.enum(['low', 'medium', 'high']),
    detailRef: z
      .string()
      .max(512)
      .optional()
      .describe(
        'Memory doc path with the full notes behind this learning; read it when the ' +
          'one-line statement is not enough.',
      ),
  })
  .strict();

export const ActiveLearningSchema = z.discriminatedUnion('kind', [
  ActiveTrajectoryLearningSchema,
  ActiveDurableLearningSchema,
  ActiveCandidateLearningSchema,
]);
export type ActiveLearning = z.infer<typeof ActiveLearningSchema>;
