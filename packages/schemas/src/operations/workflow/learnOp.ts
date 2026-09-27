import { z } from 'zod';
import { WorkflowLearningEvidenceSchema, WorkflowLearningSchema } from './learning.js';

// --- workflow.learn ---

/**
 * `slug` and `runId` are optional when the op is dispatched from inside a
 * workflow task (the harness's `workflowExecution` envelope already carries
 * them). External callers (Coach, Helmsman, ad-hoc inline calls) supply
 * them explicitly; workflow-task callers can omit. The handler derives
 * missing values from `args.workflowExecution` + the loaded run.
 */
export const WorkflowLearnInputSchema = z.object({
  slug: z.string().min(1).max(64).optional(),
  runId: z.string().uuid().optional(),
  learnings: z.array(
    WorkflowLearningSchema.omit({ evidence: true }).extend({
      evidence: WorkflowLearningEvidenceSchema.partial().optional(),
    }),
  ),
});
export type WorkflowLearnInput = z.infer<typeof WorkflowLearnInputSchema>;

export const WorkflowLearnOutputSchema = z.object({
  recorded: z.number().int(),
  totalRecordedLearnings: z.number().int(),
});
export type WorkflowLearnOutput = z.infer<typeof WorkflowLearnOutputSchema>;
