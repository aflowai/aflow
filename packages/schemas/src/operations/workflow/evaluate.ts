import { z } from 'zod';
import { WorkflowEvaluationResultSchema } from './ledger.js';

// --- workflow.evaluate ---

export const WorkflowEvaluateInputSchema = z.object({
  slug: z.string().min(1).max(64),
  runId: z.string().uuid().optional(),
  metrics: z.record(z.unknown()),
});
export type WorkflowEvaluateInput = z.infer<typeof WorkflowEvaluateInputSchema>;

export const WorkflowEvaluateOutputSchema = WorkflowEvaluationResultSchema;
export type WorkflowEvaluateOutput = z.infer<typeof WorkflowEvaluateOutputSchema>;
