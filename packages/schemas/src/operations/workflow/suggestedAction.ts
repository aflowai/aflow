import { z } from 'zod';
import { WorkflowRunCancelInputSchema } from './runCancelOp.js';
import { WorkflowRunResumeInputSchema } from './runResume.js';
import { WorkflowRunStartInputSchema } from './runStart.js';

export const WorkflowSuggestedActionSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('workflow.run.resume'),
    args: WorkflowRunResumeInputSchema,
    preconditions: z.string().max(500).optional(),
    upstreamStatePreserved: z.literal(true),
  }),
  z.object({
    op: z.literal('workflow.run.start'),
    args: WorkflowRunStartInputSchema,
    preconditions: z.string().max(500).optional(),
    upstreamStatePreserved: z.literal(false),
  }),
  z.object({
    op: z.literal('workflow.run.cancel'),
    args: WorkflowRunCancelInputSchema,
    preconditions: z.string().max(500).optional(),
    upstreamStatePreserved: z.literal(false),
  }),
]);
export type WorkflowSuggestedAction = z.infer<typeof WorkflowSuggestedActionSchema>;
