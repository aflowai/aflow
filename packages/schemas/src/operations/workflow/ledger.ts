import { z } from 'zod';
import {
  RunEvaluationEnvelopeSchema,
  RunOutcomeEvaluationSchema,
  RunOutcomeResultSchema,
} from '../../cybernetic/runEvaluationEnvelope.js';
import { WorkflowRunStatusSchema } from './enums.js';
import { WorkflowLearningSchema } from './learning.js';

// ============================================================================
// Ledger Schema
// ============================================================================

export const WorkflowTaskResultSchema = z.object({
  taskId: z.string(),
  status: z.enum([
    'completed',
    'succeeded',
    'failed',
    'skipped',
    'paused',
    'blocked',
    'scheduled',
    'running',
    'pending',
  ]),
  sessionId: z.string().optional(),
  workerSessionId: z.string().uuid().optional(),
  metrics: z.record(z.unknown()).optional(),
  summary: z.string().max(500).optional(),
  failureReason: z.string().max(1000).optional(),
  attempts: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  costCents: z.number().nonnegative().optional(),
});
export type WorkflowTaskResult = z.infer<typeof WorkflowTaskResultSchema>;

export const WorkflowOutcomeResultSchema = RunOutcomeResultSchema;

export const WorkflowEvaluationResultSchema = RunOutcomeEvaluationSchema;

export const WorkflowLedgerEntrySchema = z.object({
  runId: z.string().uuid(),
  sessionId: z.string(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  snapshot: z.object({ workflowRevision: z.number().int() }),
  status: WorkflowRunStatusSchema,
  taskResults: z.array(WorkflowTaskResultSchema),
  evaluation: RunEvaluationEnvelopeSchema.optional(),
  totalCostCents: z.number().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  learnings: z.array(WorkflowLearningSchema).optional(),
});
export type WorkflowLedgerEntry = z.infer<typeof WorkflowLedgerEntrySchema>;

export const WorkflowLedgerSchema = z.object({
  workflowId: z.string().uuid(),
  entries: z.array(WorkflowLedgerEntrySchema),
});
export type WorkflowLedger = z.infer<typeof WorkflowLedgerSchema>;

export const WorkflowTrajectoryRowSchema = z.object({
  runId: z.string().uuid(),
  status: WorkflowRunStatusSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  /** Count of recorded learnings for this run (no learnings blob shipped). */
  learningCount: z.number().int().nonnegative(),
  /** Total run cost in cents, when recorded. */
  costCents: z.number().nonnegative().optional(),
  score: z.number().nullable().optional(),
});
export type WorkflowTrajectoryRow = z.infer<typeof WorkflowTrajectoryRowSchema>;
