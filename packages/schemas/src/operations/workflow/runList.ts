import { z } from 'zod';
import { WorkflowRunStatusSchema } from './enums.js';

// --- workflow.run.list ---

/** The statuses of a run that can still act: paused among them, since a paused run resumes. */
export const WORKFLOW_RUN_NON_TERMINAL_STATUSES = ['running', 'paused'] as const;

export const WORKFLOW_RUN_LIST_LIMIT_DEFAULT = 25;
export const WORKFLOW_RUN_LIST_LIMIT_MAX = 100;

export const WorkflowRunListStatusSchema = WorkflowRunStatusSchema.extract([
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
export type WorkflowRunListStatus = z.infer<typeof WorkflowRunListStatusSchema>;

export const WorkflowRunListInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(128)
    .describe('The workflow whose runs are listed, by slug — `publish-local-changes`.'),
  input: z
    .object({
      field: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
          message: 'An input field is a run input id: letters, digits and underscores.',
        })
        .describe('A run input of that workflow, by id — `branch`.'),
      equals: z
        .union([z.string().max(512), z.number(), z.boolean()])
        .describe('The value that input must have been started with.'),
    })
    .strict()
    .describe(
      'The one run input a listed run was started with, and the value it must equal. A run started without that input is not listed.',
    ),
  status: z
    .array(WorkflowRunListStatusSchema)
    .min(1)
    .max(5)
    .default([...WORKFLOW_RUN_NON_TERMINAL_STATUSES])
    .describe(
      'The statuses listed. Absent, the runs still in flight — `running` and `paused`: a paused run resumes, so it is as much in flight as a running one.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(WORKFLOW_RUN_LIST_LIMIT_MAX)
    .default(WORKFLOW_RUN_LIST_LIMIT_DEFAULT)
    .describe(
      `How many runs at most, newest first. Default ${String(WORKFLOW_RUN_LIST_LIMIT_DEFAULT)}, max ${String(WORKFLOW_RUN_LIST_LIMIT_MAX)}; one page, and no cursor past it.`,
    ),
});
export type WorkflowRunListInput = z.infer<typeof WorkflowRunListInputSchema>;

export const WorkflowRunListItemSchema = z.object({
  id: z.string().uuid().describe('The run id, as workflow.run.detail takes it.'),
  status: WorkflowRunListStatusSchema,
  startedAt: z.string().datetime(),
  own: z
    .boolean()
    .describe(
      "Whether the run is the reading conversation's — one it drove, one under a plan root it has taken up, or one no conversation holds. `false` is another conversation's run: in flight all the same, and that conversation's to act on.",
    ),
});
export type WorkflowRunListItem = z.infer<typeof WorkflowRunListItemSchema>;

export const WorkflowRunListOutputSchema = z.object({
  runs: z
    .array(WorkflowRunListItemSchema)
    .describe('The matching runs of the whole space, whoever started them, newest first.'),
  hasMore: z
    .boolean()
    .describe('More runs match than the page holds. The read is one page by design.'),
});
export type WorkflowRunListOutput = z.infer<typeof WorkflowRunListOutputSchema>;
