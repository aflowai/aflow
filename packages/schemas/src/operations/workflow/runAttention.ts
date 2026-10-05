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
  cursor: z
    .string()
    .uuid()
    .optional()
    .describe('The `cursor` of the previous page: lists the items after it.'),
  scope: z
    .enum(['conversation', 'space'])
    .default('conversation')
    .describe(
      "'conversation' (the default) lists only this conversation's items: those about runs it drove, " +
        'runs under the plan roots it has taken up, and runs no conversation owns. ' +
        "'space' adds every other conversation's, marked `own: false` — another conversation's to act on, " +
        'not this one: read them to report, never to resume, approve or focus.',
    ),
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
  own: z
    .boolean()
    .describe(
      "Whether the item is this conversation's to act on. `false` only under `scope: 'space'`: " +
        "the item is another conversation's.",
    ),
});
export type WorkflowRunListAttentionItem = z.infer<typeof WorkflowRunListAttentionItemSchema>;

export const WorkflowRunListAttentionTruncationSchema = z
  .object({
    bound: z.literal('rows_examined'),
    value: z.number().int().min(1),
  })
  .strict();
export type WorkflowRunListAttentionTruncation = z.infer<
  typeof WorkflowRunListAttentionTruncationSchema
>;

export const WorkflowRunListAttentionOutputSchema = z.object({
  items: z.array(WorkflowRunListAttentionItemSchema),
  hasMore: z.boolean(),
  cursor: z
    .string()
    .uuid()
    .optional()
    .describe('Present while `hasMore`: pass it as `cursor` to list the next page.'),
  truncated: WorkflowRunListAttentionTruncationSchema.optional().describe(
    "Absent when the page was filled or every item was read. Otherwise the read stopped after examining `value` of the space's items before it found a page of this conversation's: " +
      '`items` holds those it found, and more may follow `cursor`.',
  ),
});
export type WorkflowRunListAttentionOutput = z.infer<typeof WorkflowRunListAttentionOutputSchema>;
