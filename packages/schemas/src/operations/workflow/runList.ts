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

export const WORKFLOW_RUN_LIST_SELECTOR_MESSAGE =
  'Name what the runs are selected by: `slug` with `input` — one workflow’s runs started with that input, narrowed by `succeeded` where it is named — or `servingNodeOfPullRequest` alone — the runs serving the plan node that pull request is linked to.';

/** The most tasks one read names in `succeeded`. */
export const WORKFLOW_RUN_LIST_SUCCEEDED_MAX = 4;

const RunListOutputPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/, {
    message: 'An output path is dotted keys and indexes: `commit.sha`, `jobs[0].id`.',
  });

export const WorkflowRunListSucceededTaskSchema = z
  .object({
    taskId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/, { message: 'A task id is letters, digits, `-` and `_`.' })
      .describe('A task of that workflow, by id — `push`.'),
    output: z
      .object({
        path: RunListOutputPathSchema.describe(
          'A path into the output the task recorded — `commit.sha`.',
        ),
        equals: z
          .union([z.string().max(512), z.number(), z.boolean()])
          .describe('The value the output must hold there.'),
      })
      .strict()
      .optional()
      .describe(
        'What the task must have recorded as well. Absent, its success alone is asked for.',
      ),
  })
  .strict();
export type WorkflowRunListSucceededTask = z.infer<typeof WorkflowRunListSucceededTaskSchema>;

export const WorkflowRunListInputSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'The workflow whose runs are listed, by slug — `publish-local-changes`. Named with `input`.',
      ),
    servingNodeOfPullRequest: z
      .string()
      .url()
      .max(2000)
      .optional()
      .describe(
        'A pull request’s URL, as GitHub’s `html_url` gives it. Lists the runs of any workflow serving the plan node that pull request is linked to, or any node under it — named instead of `slug` and `input`.',
      ),
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
      .optional()
      .describe(
        'The one run input a listed run was started with, and the value it must equal. A run started without that input is not listed. Named with `slug`.',
      ),
    succeeded: z
      .array(WorkflowRunListSucceededTaskSchema)
      .min(1)
      .max(WORKFLOW_RUN_LIST_SUCCEEDED_MAX)
      .optional()
      .describe(
        `Tasks every listed run succeeded in — and, where \`output\` is named, recorded that value at that path: a publication that pushed one commit is \`[{ taskId: 'push' }, { taskId: 'commit', output: { path: 'commit.sha', equals: <sha> } }]\`. Where any names \`output\`, the newest ${String(WORKFLOW_RUN_LIST_LIMIT_MAX)} runs that succeeded in every named task are read for it, and \`hasMore\` says where more were not. Named with \`slug\` and \`input\`.`,
      ),
    drivenByLiveConversation: z
      .literal(true)
      .optional()
      .describe(
        'Lists only the runs a Helmsman conversation started and still holds — one that has not ended. A publication so listed names the conversation that owns its branch. Named with `slug` and `input`.',
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
  })
  .superRefine((query, ctx) => {
    const byInput = query.slug !== undefined && query.input !== undefined;
    const byNode = query.servingNodeOfPullRequest !== undefined;
    const partial = (query.slug === undefined) !== (query.input === undefined);
    const byNodeWithInputFilter =
      byNode && (query.succeeded !== undefined || query.drivenByLiveConversation !== undefined);
    if (byInput === byNode || partial || byNodeWithInputFilter) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: WORKFLOW_RUN_LIST_SELECTOR_MESSAGE });
    }
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
  planNodeIds: z
    .array(z.string().uuid())
    .optional()
    .describe(
      'With `servingNodeOfPullRequest`: the plan nodes that pull request is linked to — none where no node holds it.',
    ),
  complete: z
    .boolean()
    .optional()
    .describe(
      'With `servingNodeOfPullRequest`: every node under those nodes was read. `false` means the plan below them passed the bounds of one read, so runs serving the nodes past them are not listed — treat the work as unknown, not as none.',
    ),
});
export type WorkflowRunListOutput = z.infer<typeof WorkflowRunListOutputSchema>;
