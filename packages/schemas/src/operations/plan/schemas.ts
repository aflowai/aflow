import { z } from 'zod';
import { buildOperationId } from '../../catalog/operationId.js';
import {
  OPEN_PLAN_NODE_STATUSES,
  PlanNodeCreateSchema,
  PlanNodeLinkCreateSchema,
  PlanNodeLinkSchema,
  PlanNodeRunSchema,
  PlanNodeSchema,
  PlanNodeStatusSchema,
  PlanNodeSummarySchema,
  PlanNodeUpdateFieldSchema,
  PlanNodeUpdateSchema,
  type PlanNodeLink,
  type PlanNodeRun,
  type PlanNodeSummary,
} from '../../cybernetic/plan.js';

export const PLAN_NODE_CREATE_OPERATION_ID = buildOperationId('plan', 'node', 'create');
export const PLAN_NODE_UPDATE_OPERATION_ID = buildOperationId('plan', 'node', 'update');
export const PLAN_NODE_GET_OPERATION_ID = buildOperationId('plan', 'node', 'get');
export const PLAN_NODE_LIST_OPERATION_ID = buildOperationId('plan', 'node', 'list');
export const PLAN_NODE_LINK_OPERATION_ID = buildOperationId('plan', 'node', 'link');

export const PLAN_NODE_LIST_DEFAULT_LIMIT = 50;
export const PLAN_NODE_LIST_MAX_LIMIT = 200;
/** Children `plan.node.get` returns; `plan.node.list` with `rootId` reaches the rest. */
export const PLAN_NODE_CHILDREN_LIMIT = 100;
/** Links `plan.node.get` returns, newest first. */
export const PLAN_NODE_LINKS_LIMIT = 100;
/** Runs in flight `plan.node.get` returns for a node and those under it, newest first. */
export const PLAN_NODE_RUNS_LIMIT = 50;
/** The most nodes one walk of the tree reads, whatever `limit` then returns of them. */
export const PLAN_TREE_WALK_NODE_LIMIT = 2000;

// ============================================================================
// plan.node.create / plan.node.update
// ============================================================================

export const PlanNodeCreateInputSchema = PlanNodeCreateSchema;
export type PlanNodeCreateInput = z.infer<typeof PlanNodeCreateInputSchema>;

export const PlanNodeCreateOutputSchema = z.object({ node: PlanNodeSchema });
export type PlanNodeCreateOutput = z.infer<typeof PlanNodeCreateOutputSchema>;

export const PlanNodeUpdateInputSchema = PlanNodeUpdateSchema;
export type PlanNodeUpdateInput = z.infer<typeof PlanNodeUpdateInputSchema>;

export const PlanNodeUpdateOutputSchema = z.object({ node: PlanNodeSchema });
export type PlanNodeUpdateOutput = z.infer<typeof PlanNodeUpdateOutputSchema>;

/**
 * `error.details` for `PLAN_NODE_STALE` and `PLAN_NODE_UNCHANGED`: what a retry
 * needs and no more. A refusal travels inline on the results stream, so it
 * never carries the node's prose; `plan.node.get` reads that.
 */
export const PlanNodeRefusalDetailsSchema = z
  .object({
    nodeId: z.string().uuid(),
    revision: z.number().int().min(1),
    status: PlanNodeStatusSchema,
    updatedAt: z.string().datetime(),
    differingFields: z
      .array(PlanNodeUpdateFieldSchema)
      .describe('The fields this update names whose value differs from the node as it stands.'),
  })
  .strict();
export type PlanNodeRefusalDetails = z.infer<typeof PlanNodeRefusalDetailsSchema>;

// ============================================================================
// plan.node.get / plan.node.list
// ============================================================================

export const PlanNodeGetInputSchema = z.object({ nodeId: z.string().uuid() }).strict();
export type PlanNodeGetInput = z.infer<typeof PlanNodeGetInputSchema>;

export const PlanNodeGetOutputSchema = z.object({
  node: PlanNodeSchema,
  /** Ordered by position, at most `PLAN_NODE_CHILDREN_LIMIT`. */
  children: z.array(PlanNodeSummarySchema),
  childrenTotal: z.number().int().min(0),
  /** Newest first, at most `PLAN_NODE_LINKS_LIMIT`. */
  links: z.array(PlanNodeLinkSchema),
  linksTotal: z.number().int().min(0),
  runs: z
    .array(PlanNodeRunSchema)
    .describe(
      'The runs in flight for this node and every node under it, newest first — the work this stream has under way.',
    ),
  runsTotal: z.number().int().min(0),
});
export type PlanNodeGetOutput = z.infer<typeof PlanNodeGetOutputSchema>;

export const PlanNodeListInputSchema = z
  .object({
    status: z
      .array(PlanNodeStatusSchema)
      .min(1)
      .default([...OPEN_PLAN_NODE_STATUSES])
      .describe(
        'Defaults to the open statuses. Open statuses alone read through open nodes only, so a node under a closed one is listed by naming that closed status too — except under `rootId`, whose own status filters nothing below it.',
      ),
    rootId: z
      .string()
      .uuid()
      .optional()
      .describe(
        'Only this node and those under it. A closed root still lists the open work under it, and is itself listed only when its status is named.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(PLAN_NODE_LIST_MAX_LIMIT)
      .default(PLAN_NODE_LIST_DEFAULT_LIMIT),
  })
  .strict();
export type PlanNodeListInput = z.infer<typeof PlanNodeListInputSchema>;

export const PlanTreeBoundSchema = z.enum(['limit', 'depth', 'nodes']);
export type PlanTreeBound = z.infer<typeof PlanTreeBoundSchema>;

export const PlanNodeListTruncationSchema = z
  .object({
    bound: PlanTreeBoundSchema.describe(
      '`limit`: more nodes match than `limit` returned. `depth`: nodes sit more than `value` ' +
        'levels below where the list began — list again with `rootId` nearer them. `nodes`: ' +
        'the read reached its ceiling of `value` nodes — narrow it with `rootId`.',
    ),
    value: z.number().int().min(1),
  })
  .strict();
export type PlanNodeListTruncation = z.infer<typeof PlanNodeListTruncationSchema>;

export const PlanNodeListOutputSchema = z.object({
  /** Parents before their children, siblings by position. */
  nodes: z.array(PlanNodeSummarySchema),
  truncated: PlanNodeListTruncationSchema.optional().describe(
    'Absent when every matching node is here; otherwise the bound that cut the list short.',
  ),
});
export type PlanNodeListOutput = z.infer<typeof PlanNodeListOutputSchema>;

// ============================================================================
// The space's plan as the operator reads it (Plan 322 P3)
// ============================================================================

/** Links each node of the operator's tree carries, newest first; `linksTotal` counts the rest. */
export const PLAN_TREE_NODE_LINKS_LIMIT = 20;
/** Runs in flight the operator's tree places, newest first, across every node; `runsTotal` counts the rest. */
export const PLAN_TREE_RUNS_LIMIT = 200;

/** A node with what was done for it, and the nodes under it. */
export interface PlanTreeNode extends PlanNodeSummary {
  outcome?: string;
  closedAt?: string;
  links: PlanNodeLink[];
  linksTotal: number;
  runs: PlanNodeRun[];
  children: PlanTreeNode[];
}

export const PlanTreeNodeSchema = z.lazy(() =>
  PlanNodeSummarySchema.extend({
    outcome: PlanNodeSchema.shape.outcome,
    closedAt: PlanNodeSchema.shape.closedAt,
    links: z.array(PlanNodeLinkSchema),
    linksTotal: z.number().int().min(0),
    /** The runs in flight serving this node itself; a run serving a node under it sits there. */
    runs: z.array(PlanNodeRunSchema),
    /** Siblings by position, then id. */
    children: z.array(PlanTreeNodeSchema),
  }).strict(),
) as z.ZodType<PlanTreeNode>;

export const PlanTreeOutputSchema = z.object({
  /** Every status, open and closed; roots by position, then id. */
  roots: z.array(PlanTreeNodeSchema),
  runsTotal: z
    .number()
    .int()
    .min(0)
    .describe(
      `The space's runs in flight for any node read; at most ${String(PLAN_TREE_RUNS_LIMIT)} are placed.`,
    ),
  truncated: PlanNodeListTruncationSchema.optional().describe(
    'Absent when every node of the space is here; otherwise the walk bound (`depth` or `nodes`) that cut it short.',
  ),
});
export type PlanTreeOutput = z.infer<typeof PlanTreeOutputSchema>;

// ============================================================================
// plan.node.link
// ============================================================================

export const PlanNodeLinkInputSchema = PlanNodeLinkCreateSchema;
export type PlanNodeLinkInput = z.infer<typeof PlanNodeLinkInputSchema>;

export const PlanNodeLinkOutputSchema = z.object({ link: PlanNodeLinkSchema });
export type PlanNodeLinkOutput = z.infer<typeof PlanNodeLinkOutputSchema>;

// ============================================================================
// plan.node.next — a stream continues on a schedule (Plan 322 P2b)
// ============================================================================

export const PLAN_NODE_NEXT_OPERATION_ID = buildOperationId('plan', 'node', 'next');

/**
 * How many times a firing commissions a node again after a round of it
 * failed, counted since the node was last written. The schedule's message
 * names it beside the root node.
 */
export const PLAN_STREAM_ATTEMPTS_DEFAULT = 2;
export const PLAN_STREAM_ATTEMPTS_MAX = 10;

/** The catalog skills a round of a stream runs: the commission and its publication. */
export const PLAN_STREAM_COMMISSION_SLUG = 'commission-change';
export const PLAN_STREAM_PUBLICATION_SLUG = 'publish-local-changes';

/** The platform role a stream's schedule starts. */
export const PLAN_STREAM_SCHEDULE_TARGET = {
  kind: 'platform-role',
  systemRole: 'cybernetic-helmsman',
} as const;

const PlanStreamPullRequestReadSchema = z
  .object({
    url: z
      .string()
      .url()
      .describe('The pull request this answer is for, as the decision named it.'),
    read: z.literal('ok'),
    state: z.enum(['open', 'closed']).describe('GitHub’s `state`.'),
    merged: z.boolean().describe('GitHub’s `merged`.'),
    mergedAt: z.string().datetime().nullish().describe('GitHub’s `merged_at`.'),
    closedAt: z.string().datetime().nullish().describe('GitHub’s `closed_at`.'),
    mergeCommitSha: z.string().min(1).nullish().describe('GitHub’s `merge_commit_sha`.'),
  })
  .strict();

const PlanStreamPullRequestUnreadSchema = z
  .object({
    url: z.string().url(),
    read: z.literal('failed').describe('GitHub refused the read, or it could not be made.'),
  })
  .strict();

export const PLAN_STREAM_MERGED_NEEDS_TIME_MESSAGE =
  'A merged pull request is closed and has `merged_at`: copy `state`, `merged`, `merged_at` and `closed_at` from GitHub’s answer as they stand.';
export const PLAN_STREAM_CLOSED_NEEDS_TIME_MESSAGE =
  'A closed pull request has `closed_at`: copy it from GitHub’s answer.';

export const PlanStreamPullRequestAnswerSchema = z
  .discriminatedUnion('read', [PlanStreamPullRequestReadSchema, PlanStreamPullRequestUnreadSchema])
  .superRefine((answer, ctx) => {
    if (answer.read !== 'ok') return;
    if (answer.merged && (answer.mergedAt == null || answer.state !== 'closed')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mergedAt'],
        message: PLAN_STREAM_MERGED_NEEDS_TIME_MESSAGE,
      });
    }
    if (answer.state === 'closed' && answer.closedAt == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['closedAt'],
        message: PLAN_STREAM_CLOSED_NEEDS_TIME_MESSAGE,
      });
    }
  });
export type PlanStreamPullRequestAnswer = z.infer<typeof PlanStreamPullRequestAnswerSchema>;

export const PlanNodeNextInputSchema = z
  .object({
    rootNodeId: z
      .string()
      .uuid()
      .describe('The stream: its root node, as the schedule’s message names it.'),
    attempts: z
      .number()
      .int()
      .min(1)
      .max(PLAN_STREAM_ATTEMPTS_MAX)
      .default(PLAN_STREAM_ATTEMPTS_DEFAULT)
      .describe(
        'How many times a node whose round failed is commissioned again before the stream stops on it, as the schedule’s message names it.',
      ),
    pullRequest: PlanStreamPullRequestAnswerSchema.optional().describe(
      'Only after a `read_pull_request` decision: GitHub’s answer for the pull request it named, read through the space’s GitHub binding — or `read: "failed"` where that read failed.',
    ),
  })
  .strict();
export type PlanNodeNextInput = z.infer<typeof PlanNodeNextInputSchema>;

/** The active node as a decision names it. */
export const PlanStreamNodeSchema = z
  .object({
    nodeId: z.string().uuid(),
    title: z.string(),
    status: PlanNodeStatusSchema,
    revision: z.number().int().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type PlanStreamNode = z.infer<typeof PlanStreamNodeSchema>;

/** What a round is briefed from: the node's goal and criteria, and its note. */
export const PlanStreamBriefNodeSchema = PlanStreamNodeSchema.extend({
  goal: z.string(),
  criteria: z.string(),
  note: z.string().optional(),
}).strict();
export type PlanStreamBriefNode = z.infer<typeof PlanStreamBriefNodeSchema>;

export const PlanStreamWaitCauseSchema = z.enum([
  'stream_closed',
  'blocked',
  'in_flight',
  'claimed',
  'pull_request_open',
  'read_failed',
  'awaiting_publication',
  'unknown_state',
]);
export type PlanStreamWaitCause = z.infer<typeof PlanStreamWaitCauseSchema>;

export const PlanStreamStopCauseSchema = z.enum([
  'pull_request_closed',
  'publication_denied',
  'attempts_spent',
]);
export type PlanStreamStopCause = z.infer<typeof PlanStreamStopCauseSchema>;

export const PlanStreamRetryCauseSchema = z.enum([
  'commission_failed',
  'commission_cancelled',
  'publication_failed',
  'fix_before_merge',
]);
export type PlanStreamRetryCause = z.infer<typeof PlanStreamRetryCauseSchema>;

const decisionReason = z.string().describe('Why, naming the records it was read from.');

export const PlanStreamRetrySchema = z
  .object({
    cause: PlanStreamRetryCauseSchema,
    runId: z.string().describe('The run whose end this round answers.'),
    slug: z.string(),
    failure: z.string().optional().describe('The run’s own account of its failure.'),
    reviewRunId: z
      .string()
      .optional()
      .describe('On fix_before_merge: the review run whose findings the fix is briefed from.'),
  })
  .strict();
export type PlanStreamRetry = z.infer<typeof PlanStreamRetrySchema>;

export const PlanNodeNextOutputSchema = z.discriminatedUnion('decision', [
  z
    .object({
      decision: z.literal('read_pull_request'),
      reason: decisionReason,
      node: PlanStreamNodeSchema,
      pullRequest: z
        .object({
          url: z.string(),
          owner: z.string(),
          repo: z.string(),
          number: z.number().int().min(1),
        })
        .strict()
        .describe(
          'Read it with the space’s GitHub binding (`getPullRequest`: owner, repo, pull_number), then call plan.node.next again with the same rootNodeId and attempts and `pullRequest` set from the answer.',
        ),
    })
    .strict(),
  z
    .object({
      decision: z.literal('record_merge'),
      reason: decisionReason,
      node: PlanStreamBriefNodeSchema,
      pullRequest: z
        .object({
          url: z.string(),
          mergedAt: z.string().datetime(),
          mergeCommitSha: z.string().optional(),
        })
        .strict(),
      noteHead: z
        .string()
        .describe(
          'Where the criteria are not met, the note’s first line begins with this, and goes on to name the next step.',
        ),
      link: PlanNodeLinkCreateSchema.describe(
        'The record that this merge was judged: pass it to plan.node.link once the node’s update is written. Until it is linked, the next firing judges the merge again.',
      ),
    })
    .strict(),
  z
    .object({
      decision: z.literal('wait'),
      reason: decisionReason,
      cause: PlanStreamWaitCauseSchema,
      node: PlanStreamNodeSchema.optional().describe('Absent where the stream has no open node.'),
    })
    .strict(),
  z
    .object({
      decision: z.literal('stop'),
      reason: decisionReason,
      cause: PlanStreamStopCauseSchema,
      node: PlanStreamNodeSchema,
      update: PlanNodeUpdateSchema.describe(
        'The write that holds the stream on this node: pass it to plan.node.update as it stands.',
      ),
    })
    .strict(),
  z
    .object({
      decision: z.literal('continue'),
      reason: decisionReason,
      node: PlanStreamBriefNodeSchema,
      retry: PlanStreamRetrySchema.optional().describe(
        'Absent for the node’s first round since its last write.',
      ),
      attemptsUsed: z
        .number()
        .int()
        .min(0)
        .describe('Rounds of this node that ended without a pull request since its last write.'),
      attempts: z.number().int().min(1),
    })
    .strict(),
]);
export type PlanNodeNextOutput = z.infer<typeof PlanNodeNextOutputSchema>;
export type PlanStreamDecision = PlanNodeNextOutput['decision'];

/**
 * The message a stream's schedule starts the Helmsman with: the stream's root
 * and its attempt budget, and nothing else — a firing carries no live value
 * (Plan 321 §5 P0.1), so everything it acts on it reads when it fires.
 */
export function planStreamFiringMessage(rootNodeId: string, attempts: number): string {
  const input = JSON.stringify({ rootNodeId, attempts });
  return `Continue the plan stream ${rootNodeId}: call ${PLAN_NODE_NEXT_OPERATION_ID} with ${input} and act on its decision.`;
}

/** The `input` of `agent.schedule.create` for a stream's schedule. */
export function planStreamScheduleInput(
  rootNodeId: string,
  attempts: number = PLAN_STREAM_ATTEMPTS_DEFAULT,
): { input: string } {
  return { input: planStreamFiringMessage(rootNodeId, attempts) };
}
