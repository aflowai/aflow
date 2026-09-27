import { z } from 'zod';
import { campaignParam, ThresholdOperatorSchema } from '../../cybernetic/campaignRef.js';

// ============================================================================
// Outcome Schema (replaces Criterion)
// ============================================================================

const ThresholdEvaluatorSchema = z.object({
  type: z.literal('threshold'),
  metric: z.string().min(1).max(64),
  operator: campaignParam(ThresholdOperatorSchema),
  target: campaignParam(z.number()),
  targetHigh: z.number().optional(),
});

const MaterializedThresholdEvaluatorSchema = z.object({
  type: z.literal('threshold'),
  metric: z.string().min(1).max(64),
  operator: ThresholdOperatorSchema,
  target: z.number(),
  targetHigh: z.number().optional(),
});

const PatternEvaluatorSchema = z.object({
  type: z.literal('pattern'),
  metric: z.string().min(1).max(64),
  pattern: z.string().min(1).max(500),
});

const ManualEvaluatorSchema = z.object({
  type: z.literal('manual'),
  instruction: z.string().min(1).max(500),
});

export const OutcomeSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  evaluator: z.discriminatedUnion('type', [
    ThresholdEvaluatorSchema,
    PatternEvaluatorSchema,
    ManualEvaluatorSchema,
  ]),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

export const MaterializedOutcomeSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  evaluator: z.discriminatedUnion('type', [
    MaterializedThresholdEvaluatorSchema,
    PatternEvaluatorSchema,
    ManualEvaluatorSchema,
  ]),
});
export type MaterializedOutcome = z.infer<typeof MaterializedOutcomeSchema>;
