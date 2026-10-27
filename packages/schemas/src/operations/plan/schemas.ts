import { z } from 'zod';
import { buildOperationId } from '../../catalog/operationId.js';
import {
  COACH_LEARNING_SUPERSEDES_MAX,
  CoachLearningKindSchema,
  CoachLearningSchema,
} from '../../cybernetic/coachLearning.js';
import {
  OPEN_PLAN_NODE_STATUSES,
  PlanNodeCloseSchema,
  PlanNodeCreateSchema,
  PlanNodeDependencyConditionSchema,
  PlanNodeDependencySchema,
  PlanNodeDependencyViewSchema,
  PlanNodeLearningSchema,
  PlanNodeLinkCreateSchema,
  PlanNodeLinkKindSchema,
  PlanNodeLinkSchema,
  PlanNodeRunSchema,
  PlanNodeSchema,
  PlanNodeStatusSchema,
  PlanNodeSummarySchema,
  PlanNodeUpdateFieldSchema,
  PlanNodeUpdateSchema,
  isClosedPlanNodeStatus,
  type PlanNodeKind,
  type PlanNodeStatus,
  type PlanNodeSummary,
} from '../../cybernetic/plan.js';

export const PLAN_NODE_CREATE_OPERATION_ID = buildOperationId('plan', 'node', 'create');
export const PLAN_NODE_UPDATE_OPERATION_ID = buildOperationId('plan', 'node', 'update');
export const PLAN_NODE_GET_OPERATION_ID = buildOperationId('plan', 'node', 'get');
export const PLAN_NODE_LIST_OPERATION_ID = buildOperationId('plan', 'node', 'list');
export const PLAN_NODE_LINK_OPERATION_ID = buildOperationId('plan', 'node', 'link');
export const PLAN_NODE_LEARN_OPERATION_ID = buildOperationId('plan', 'node', 'learn');
export const PLAN_NODE_DEPEND_OPERATION_ID = buildOperationId('plan', 'node', 'depend');

export const PLAN_NODE_LIST_DEFAULT_LIMIT = 100;
export const PLAN_NODE_LIST_MAX_LIMIT = 200;
/** Children `plan.node.get` returns; `plan.node.list` with `rootId` reaches the rest. */
export const PLAN_NODE_CHILDREN_LIMIT = 100;
/** Links `plan.node.get` returns, newest first. */
export const PLAN_NODE_LINKS_LIMIT = 100;
/** Runs in flight `plan.node.get` returns for a node and those under it, newest first. */
export const PLAN_NODE_RUNS_LIMIT = 50;
/** The most nodes one walk of the tree reads, whatever `limit` then returns of them. */
export const PLAN_TREE_WALK_NODE_LIMIT = 2000;
/** Each of a node's dependencies and dependents `plan.node.get` returns. */
export const PLAN_NODE_DEPENDENCIES_LIMIT = 100;
/** Learnings `plan.node.get` returns from the node and those above it, newest first. */
export const PLAN_NODE_LEARNINGS_LIMIT = 50;

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
  dependencies: z
    .array(PlanNodeDependencyViewSchema)
    .describe(
      'The nodes this one waits on, each with the outcome it waits for and whether that is met.',
    ),
  dependenciesTotal: z.number().int().min(0),
  dependents: z
    .array(PlanNodeDependencyViewSchema)
    .describe(
      'The nodes that wait on this one, and whether its outcome meets what each waits for.',
    ),
  dependentsTotal: z.number().int().min(0),
  learnings: z
    .array(PlanNodeLearningSchema)
    .describe(
      'What earlier sessions learned working this node and the nodes above it, newest first — read them before briefing a round.',
    ),
  learningsTotal: z.number().int().min(0),
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
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Absent for the first page. Otherwise `truncated.next.cursor` of the page before, with the same `status` and `rootId`.',
      ),
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

/** A list cut short: the bound, how many nodes it found, and where the next page starts. */
export const PlanNodeListPageTruncationSchema = PlanNodeListTruncationSchema.extend({
  matched: z
    .number()
    .int()
    .min(0)
    .describe(
      'Nodes the read found that match `status`, across every page. Exact for `limit`; for ' +
        '`depth` or `nodes` at least this many, since the read stopped before the rest.',
    ),
  next: z
    .object({ cursor: z.string().min(1) })
    .strict()
    .optional()
    .describe(
      'Present while nodes the read found remain past this page: list again with the same input and this ' +
        '`cursor`. It holds the plan as this page read it, so if a node is created, closed, reopened or ' +
        'moved before the next page, that page is refused, not shifted. Then list again without `cursor`.',
    ),
}).strict();
export type PlanNodeListPageTruncation = z.infer<typeof PlanNodeListPageTruncationSchema>;

export const PlanNodeListOutputSchema = z.object({
  /** Parents before their children, siblings by position. */
  nodes: z.array(PlanNodeSummarySchema),
  truncated: PlanNodeListPageTruncationSchema.optional().describe(
    'Absent when every matching node is here. Present, `nodes` is one page, not the whole plan: ' +
      'count from `matched`, and page with `next` while it is present. Under `depth` or `nodes` ' +
      'the read stopped before the end of the plan. Once `next` is absent, paging has nothing ' +
      'more to give, and the rest is reached with `rootId`, as `bound` says.',
  ),
});
export type PlanNodeListOutput = z.infer<typeof PlanNodeListOutputSchema>;

// ============================================================================
// The space's plan as the operator reads it (Plan 322 P3)
// ============================================================================

/** How much of the goal a tree node carries; the node detail reads the rest. */
export const PLAN_NODE_GOAL_HEAD_MAX_CHARS = 160;

/** How much of the note's first line a tree node carries, as much as of the goal. */
export const PLAN_NODE_NOTE_HEAD_MAX_CHARS = PLAN_NODE_GOAL_HEAD_MAX_CHARS;

/**
 * The workflows whose runs are a node's review rounds, as a run link names
 * them (`<slug> <status>`, `linkEndedRun`). A review started under a
 * publication inherits the publication's node, so it is linked there too.
 */
export const PLAN_REVIEW_WORKFLOW_SLUGS = ['review-local-changes', 'review-pull-request'] as const;

/** What a node's links and runs add up to, without the links themselves. */
export const PlanNodeCountsSchema = z
  .object({
    runs: z.number().int().min(0).describe('Run links: runs that served the node and ended.'),
    pullRequests: z.number().int().min(0),
    findings: z.number().int().min(0),
    documents: z.number().int().min(0),
    inFlightRuns: z
      .number()
      .int()
      .min(0)
      .describe('Runs serving the node itself now, running or paused.'),
  })
  .strict();
export type PlanNodeCounts = z.infer<typeof PlanNodeCountsSchema>;

/**
 * Whether the loop is moving a node now. `in_flight`: a run in flight serves
 * the node or one of its active descendants — runs serve the steps under a
 * root or phase, rarely the parent itself. `idle`: none does, and nothing is
 * asked of the operator by it — the loop picks it up when it reaches it. A
 * run starting moves a node to `in_flight`; its last run ending moves it back.
 * Who a node waits on is not read from here: a `decide` node is the
 * operator's by its kind, whatever its activity, and the board's column rule
 * (`planBoardColumn`) places it under Needs you.
 */
export const PlanNodeActivitySchema = z.enum(['in_flight', 'idle']);
export type PlanNodeActivity = z.infer<typeof PlanNodeActivitySchema>;

/** The node's newest pull request, and whether a merge of it was recorded. */
export const PlanNodePullRequestSchema = z
  .object({
    url: z.string(),
    merged: z.boolean().describe('The node holds a `merge` link to this pull request.'),
    mergeSha: z.string().optional().describe('The merge commit, where the merge link names it.'),
  })
  .strict();
export type PlanNodePullRequest = z.infer<typeof PlanNodePullRequestSchema>;

/**
 * A node as a board card shows it, and the nodes under it: no links, no prose
 * past the goal's head and the note's first line.
 */
export interface PlanTreeNode extends PlanNodeSummary {
  goalHead: string;
  counts: PlanNodeCounts;
  rounds: number;
  activity: PlanNodeActivity;
  pullRequest?: PlanNodePullRequest;
  progress?: { done: number; total: number };
  children: PlanTreeNode[];
}

export const PlanTreeNodeSchema = z.lazy(() =>
  PlanNodeSummarySchema.extend({
    goalHead: z.string().max(PLAN_NODE_GOAL_HEAD_MAX_CHARS),
    noteHead: z
      .string()
      .max(PLAN_NODE_NOTE_HEAD_MAX_CHARS)
      .optional()
      .describe('The note’s first line; absent where the node has no note.'),
    counts: PlanNodeCountsSchema,
    rounds: z
      .number()
      .int()
      .min(0)
      .describe('Review rounds: run links of a `PLAN_REVIEW_WORKFLOW_SLUGS` workflow.'),
    activity: PlanNodeActivitySchema,
    pullRequest: PlanNodePullRequestSchema.optional(),
    progress: z
      .object({ done: z.number().int().min(0), total: z.number().int().min(0) })
      .strict()
      .optional()
      .describe('A parent only: its children done, of those not dropped.'),
    /** Siblings by position, then id. */
    children: z.array(PlanTreeNodeSchema),
  }).strict(),
) as z.ZodType<PlanTreeNode>;

/** A calendar day in the reader's time zone, `YYYY-MM-DD`. */
export const PlanDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PlanDoneDaySchema = z
  .object({ day: PlanDaySchema, count: z.number().int().min(1) })
  .strict();
export type PlanDoneDay = z.infer<typeof PlanDoneDaySchema>;

/**
 * One plan as its tab and header show it, counted over every node under the
 * root by the board's column rule — whatever `closedSince` left out of the tree.
 */
export const PlanRootTallySchema = z
  .object({
    rootId: z.string().uuid(),
    steps: z.number().int().min(0).describe('Nodes under the root.'),
    needsYou: z.number().int().min(0).describe('Nodes in the board’s Needs you column.'),
    inFlight: z.number().int().min(0).describe('Nodes in the board’s In flight column.'),
    upNext: z.number().int().min(0).describe('Nodes in the board’s Up next column.'),
    done: z.number().int().min(0),
    dropped: z.number().int().min(0),
    doneByDay: z
      .array(PlanDoneDaySchema)
      .describe('Done nodes by the day they closed, newest first, one entry per day with any.'),
    nextNodeId: z
      .string()
      .uuid()
      .optional()
      .describe(
        'The step under the root the stream walk (`findActiveStreamNode`) takes next; absent where it takes none.',
      ),
  })
  .strict();
export type PlanRootTally = z.infer<typeof PlanRootTallySchema>;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const PlanTreeQuerySchema = z
  .object({
    closedSince: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(
        'Leave out done nodes closed before this instant, unless a node kept sits under one.',
      ),
    tz: z
      .string()
      .min(1)
      .max(64)
      .refine(isTimeZone, { message: 'tz is an IANA time zone, e.g. Europe/Paris.' })
      .optional()
      .describe('The time zone `doneByDay` counts days in; UTC when absent.'),
  })
  .strict();
export type PlanTreeQuery = z.infer<typeof PlanTreeQuerySchema>;

export const PlanTreeOutputSchema = z.object({
  /** Roots by position, then id; every root, whatever its status or `closedSince`. */
  roots: z.array(PlanTreeNodeSchema),
  /** One per root, in the roots' order. */
  tallies: z.array(PlanRootTallySchema),
  truncated: PlanNodeListTruncationSchema.optional().describe(
    'Absent when every node of the space is here; otherwise the walk bound (`depth` or `nodes`) that cut it short.',
  ),
});
export type PlanTreeOutput = z.infer<typeof PlanTreeOutputSchema>;

/** Which board column a node stands in. */
export type PlanBoardColumn = 'needs_you' | 'in_flight' | 'up_next' | 'done' | 'dropped';

/**
 * Why a node stands under Needs you: an open `decide` node, a node `blocked`
 * on a person, or an open node under a closed ancestor — which the stream
 * walk never reaches until the ancestor is reopened or the step dropped.
 */
export const PlanNeedsYouReasonSchema = z.enum(['decide', 'blocked', 'stranded']);
export type PlanNeedsYouReason = z.infer<typeof PlanNeedsYouReasonSchema>;

/** A node's column, and for Needs you why. */
export type PlanBoardPlacement =
  | { column: 'needs_you'; reason: PlanNeedsYouReason }
  | { column: Exclude<PlanBoardColumn, 'needs_you'>; reason?: never };

/**
 * The board's one rule for a node's column (Plan 332 D4), read by the tallies
 * and the page alike; the first match decides. The node alone cannot know
 * whether a closed node lies above it, so the walk that reached it says.
 */
export function planBoardColumn(
  node: { kind: PlanNodeKind; status: PlanNodeStatus; activity: PlanNodeActivity },
  under: { closedAncestor: boolean },
): PlanBoardPlacement {
  if (node.status === 'done') return { column: 'done' };
  if (node.status === 'dropped') return { column: 'dropped' };
  if (under.closedAncestor) return { column: 'needs_you', reason: 'stranded' };
  if (node.kind === 'decide') return { column: 'needs_you', reason: 'decide' };
  if (node.status === 'blocked') return { column: 'needs_you', reason: 'blocked' };
  if (node.status === 'waiting' || node.activity === 'in_flight') return { column: 'in_flight' };
  return { column: 'up_next' };
}

/** A node under a root as the board places it; its phase is its ancestor directly under the root. */
export type PlanBoardCard = PlanBoardPlacement & { node: PlanTreeNode; phase?: PlanTreeNode };

/**
 * Every node under `root`, never the root, in the walk's order — parents
 * before children, siblings as the tree holds them — each placed by
 * `planBoardColumn` with whether a closed node, the root included, lies above it.
 */
export function planBoardCards(root: PlanTreeNode): PlanBoardCard[] {
  const cards: PlanBoardCard[] = [];
  const visit = (node: PlanTreeNode, phase: PlanTreeNode | undefined, closedAncestor: boolean) => {
    cards.push({
      ...planBoardColumn(node, { closedAncestor }),
      node,
      ...(phase !== undefined ? { phase } : {}),
    });
    const closedBelow = closedAncestor || isClosedPlanNodeStatus(node.status);
    for (const child of node.children) visit(child, phase ?? node, closedBelow);
  };
  const rootClosed = isClosedPlanNodeStatus(root.status);
  for (const child of root.children) visit(child, undefined, rootClosed);
  return cards;
}

// ============================================================================
// One node for the board's rail, its links paged (Plan 322 P3.3)
// ============================================================================

export const PLAN_NODE_DETAIL_LINKS_DEFAULT_LIMIT = 50;
export const PLAN_NODE_DETAIL_LINKS_MAX_LIMIT = 200;

export const PlanNodeDetailQuerySchema = z
  .object({
    linkKind: PlanNodeLinkKindSchema.optional().describe('Only links of this kind.'),
    cursor: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe('`nextCursor` of the page before; absent for the newest page.'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PLAN_NODE_DETAIL_LINKS_MAX_LIMIT)
      .default(PLAN_NODE_DETAIL_LINKS_DEFAULT_LIMIT),
  })
  .strict();
export type PlanNodeDetailQuery = z.infer<typeof PlanNodeDetailQuerySchema>;

export const PlanNodeDetailOutputSchema = z.object({
  node: PlanNodeSchema,
  /** Ordered by position, at most `PLAN_NODE_CHILDREN_LIMIT`. */
  children: z.array(PlanNodeSummarySchema),
  childrenTotal: z.number().int().min(0),
  /** One page of links, newest first, of `linkKind` where one was named. */
  links: z.array(PlanNodeLinkSchema),
  /** Every link of `linkKind` — or of any kind — the node holds. */
  linksTotal: z.number().int().min(0),
  nextCursor: z.string().optional().describe('Absent on the last page.'),
  /** The runs in flight for this node and every node under it, newest first. */
  runs: z.array(PlanNodeRunSchema),
  runsTotal: z.number().int().min(0),
});
export type PlanNodeDetailOutput = z.infer<typeof PlanNodeDetailOutputSchema>;

// ============================================================================
// The operator's writes (Plan 322 P3.2)
// ============================================================================

/** `PATCH /v1/spaces/:spaceId/plan/nodes/:nodeId` — the operator closes a node. */
export const PlanNodeCloseInputSchema = PlanNodeCloseSchema;
export type PlanNodeCloseInput = z.infer<typeof PlanNodeCloseInputSchema>;

/** An operator's write the engine refused, with what a retry needs. */
export const PlanNodeWriteRefusalSchema = z.object({
  error: z.string().describe('The engine’s code, e.g. `PLAN_NODE_STALE`.'),
  message: z.string(),
  current: PlanNodeRefusalDetailsSchema.optional().describe(
    'For a stale or unchanged write: the node as it now stands — write again against `current.revision`.',
  ),
});
export type PlanNodeWriteRefusal = z.infer<typeof PlanNodeWriteRefusalSchema>;

// ============================================================================
// plan.node.link
// ============================================================================

export const PlanNodeLinkInputSchema = PlanNodeLinkCreateSchema;
export type PlanNodeLinkInput = z.infer<typeof PlanNodeLinkInputSchema>;

export const PlanNodeLinkOutputSchema = z.object({ link: PlanNodeLinkSchema });
export type PlanNodeLinkOutput = z.infer<typeof PlanNodeLinkOutputSchema>;

// ============================================================================
// plan.node.learn — a learning scoped to a node (Plan 322 D8, P2)
// ============================================================================

export const PlanNodeLearnInputSchema = z
  .object({
    nodeId: z.string().uuid().describe('The node the learning is about.'),
    kind: CoachLearningKindSchema,
    statement: CoachLearningSchema.shape.statement.describe(
      'The claim, standing on its own: the next session reads it without this conversation.',
    ),
    evidence: z
      .object({
        citations: CoachLearningSchema.shape.evidence.shape.citations.describe(
          'The runs it was learned from.',
        ),
      })
      .strict(),
    confidence: CoachLearningSchema.shape.confidence,
    supersedes: z
      .array(z.string().uuid())
      .max(COACH_LEARNING_SUPERSEDES_MAX)
      .optional()
      .describe(
        'Learnings written on this same node that this one replaces; they are no longer read.',
      ),
  })
  .strict();
export type PlanNodeLearnInput = z.infer<typeof PlanNodeLearnInputSchema>;

export const PlanNodeLearnOutputSchema = z.object({
  learning: PlanNodeLearningSchema,
  superseded: z.array(z.string().uuid()),
});
export type PlanNodeLearnOutput = z.infer<typeof PlanNodeLearnOutputSchema>;

// ============================================================================
// plan.node.depend — a node waits on another's outcome (Plan 322 P2)
// ============================================================================

export const PLAN_NODE_DEPEND_ONE_OF_MESSAGE =
  'Name exactly one of `condition` (set the edge, or change what it waits for) and `remove: true` (take it away).';

export const PlanNodeDependInputSchema = z
  .object({
    nodeId: z.string().uuid().describe('The node that waits.'),
    expectedRevision: z
      .number()
      .int()
      .min(1)
      .describe('The revision of `nodeId` the change was decided against.'),
    dependsOnId: z.string().uuid().describe('The node it waits on.'),
    condition: PlanNodeDependencyConditionSchema.optional().describe(
      'The outcome it waits for: `done`, `dropped`, or `closed` (either).',
    ),
    remove: z.literal(true).optional().describe('Take the edge away.'),
  })
  .strict()
  .superRefine((input, ctx) => {
    if ((input.condition === undefined) === (input.remove === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: PLAN_NODE_DEPEND_ONE_OF_MESSAGE });
    }
  });
export type PlanNodeDependInput = z.infer<typeof PlanNodeDependInputSchema>;

export const PlanNodeDependOutputSchema = z.object({
  node: PlanNodeSchema.describe('The waiting node at its new revision.'),
  dependency: PlanNodeDependencySchema.optional().describe(
    'The edge as it now stands; absent once removed.',
  ),
});
export type PlanNodeDependOutput = z.infer<typeof PlanNodeDependOutputSchema>;

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
  'awaiting_decision',
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
