import { z } from 'zod';

// --- workflow.run.list_attention ---

export const WorkflowRunListAttentionInputSchema = z.object({
  /** When true, includes already-consumed items. Defaults to pending only. */
  includeConsumed: z.boolean().default(false),
  /** Filter by attention kind. */
  kind: z
    .enum([
      'workflow_run_completed',
      'workflow_run_paused',
      'workflow_run_failed',
      'workflow_run_cancelled',
    ])
    .optional(),
  /** Page size. Default 25, max 100. */
  limit: z.number().int().min(1).max(100).default(25),
});
export type WorkflowRunListAttentionInput = z.infer<typeof WorkflowRunListAttentionInputSchema>;

export const WorkflowRunListAttentionItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum([
    'workflow_run_completed',
    'workflow_run_paused',
    'workflow_run_failed',
    'workflow_run_cancelled',
  ]),
  relatedRunId: z.string().optional(),
  relatedResource: z.string().optional(),
  payload: z.record(z.unknown()),
  priority: z.number().int(),
  createdAt: z.string().datetime(),
  consumedAt: z.string().datetime().optional(),
  suggestedNextCall: z
    .object({
      op: z.literal('human.action_center.focus'),
      args: z.object({ itemId: z.string() }),
    })
    .optional(),
});
export type WorkflowRunListAttentionItem = z.infer<typeof WorkflowRunListAttentionItemSchema>;

export const WorkflowRunListAttentionOutputSchema = z.object({
  items: z.array(WorkflowRunListAttentionItemSchema),
  hasMore: z.boolean(),
});
export type WorkflowRunListAttentionOutput = z.infer<typeof WorkflowRunListAttentionOutputSchema>;
