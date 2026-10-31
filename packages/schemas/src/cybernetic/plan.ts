import { z } from 'zod';
import { CoachLearningKindSchema, CoachLearningSchema } from './coachLearning.js';

// ============================================================================
// Plan 322 — a space's plan is a tree of nodes the Helmsman works through.
// ============================================================================

/**
 * The mode of work a node asks for: `execute` builds something, `investigate`
 * finds something out, `decide` ends in the operator's choice.
 */
export const PlanNodeKindSchema = z.enum(['execute', 'investigate', 'decide']);
export type PlanNodeKind = z.infer<typeof PlanNodeKindSchema>;

/**
 * `waiting` is on a run, `blocked` is on a person. `done` and `dropped` close
 * the node; the others leave it open.
 */
export const PlanNodeStatusSchema = z.enum(['active', 'waiting', 'blocked', 'done', 'dropped']);
export type PlanNodeStatus = z.infer<typeof PlanNodeStatusSchema>;

export const OPEN_PLAN_NODE_STATUSES: readonly PlanNodeStatus[] = ['active', 'waiting', 'blocked'];
export const CLOSED_PLAN_NODE_STATUSES: readonly PlanNodeStatus[] = ['done', 'dropped'];

export function isClosedPlanNodeStatus(status: PlanNodeStatus): boolean {
  return CLOSED_PLAN_NODE_STATUSES.includes(status);
}

/**
 * The deepest a node may sit below its root, a root being depth 0. Create and
 * move refuse past it and a read walks no further down. A write reads its
 * parent's ancestors one locked row at a time, so this bounds a write's cost.
 */
export const PLAN_TREE_DEPTH_LIMIT = 64;

/** `plan_nodes.position` is a Postgres INTEGER; a larger value fails in the database. */
export const PLAN_NODE_POSITION_MAX = 2_147_483_647;

/** Storage ceilings: these fields hold model-authored prose a person reads. */
export const PLAN_NODE_TITLE_MAX_CHARS = 500;
export const PLAN_NODE_PROSE_MAX_CHARS = 64_000;

export const PLAN_NODE_TITLE_ONE_LINE_MESSAGE =
  'A title is one line: the attention block shows each node on a line of its own. Put the rest in the goal or the note.';

const PlanNodeTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(PLAN_NODE_TITLE_MAX_CHARS)
  .regex(/^[^\r\n]*$/, { message: PLAN_NODE_TITLE_ONE_LINE_MESSAGE });
const PlanNodeProseSchema = z.string().trim().min(1).max(PLAN_NODE_PROSE_MAX_CHARS);
const PlanNodeNoteSchema = z
  .string()
  .max(PLAN_NODE_PROSE_MAX_CHARS)
  .describe('Its first line shows in the attention block; "" clears it.');
const PlanNodePositionSchema = z
  .number()
  .int()
  .min(0)
  .max(PLAN_NODE_POSITION_MAX, {
    message: `A position is at most ${String(PLAN_NODE_POSITION_MAX)}. Only the order among siblings counts, so number them 0, 1, 2… — or leave it out to place the node after its last sibling.`,
  })
  .describe('Order among siblings, lowest first.');

// ============================================================================
// Plan 337 D1 — the card a node that asks for a decision carries
// ============================================================================

/** Storage ceilings, not style: one item of a card, and one list of them. */
export const PLAN_NODE_CARD_ITEM_MAX_CHARS = 4_000;
export const PLAN_NODE_CARD_LIST_MAX_ITEMS = 50;
/** The whole card, serialised: the ceiling every other prose field of a node has. */
export const PLAN_NODE_CARD_MAX_CHARS = PLAN_NODE_PROSE_MAX_CHARS;

export const PLAN_NODE_CARD_KEYS_MESSAGE =
  'A card holds change, why, affects, risks, questions and notDoing, and nothing else. Done when is the node’s criteria, so the card does not repeat it.';

const PlanNodeCardItemSchema = z.string().trim().min(1).max(PLAN_NODE_CARD_ITEM_MAX_CHARS);
const PlanNodeCardListSchema = z.array(PlanNodeCardItemSchema).max(PLAN_NODE_CARD_LIST_MAX_ITEMS);

export const PlanNodeCardSchema = z
  .object({
    change: z
      .object({ today: PlanNodeCardItemSchema, after: PlanNodeCardItemSchema })
      .strict()
      .describe('What changes: how it is today, and how it is after.'),
    why: PlanNodeCardListSchema.min(1).describe('Why: the reasons, at least one.'),
    affects: PlanNodeCardListSchema.describe('What it affects: packages, surfaces, people.'),
    risks: z
      .array(
        z
          .object({ risk: PlanNodeCardItemSchema, mitigation: PlanNodeCardItemSchema.optional() })
          .strict(),
      )
      .max(PLAN_NODE_CARD_LIST_MAX_ITEMS),
    questions: z
      .array(
        z
          .object({ question: PlanNodeCardItemSchema, recommended: PlanNodeCardItemSchema })
          .strict(),
      )
      .max(PLAN_NODE_CARD_LIST_MAX_ITEMS)
      .describe('Open questions, each with the answer you recommend.'),
    notDoing: PlanNodeCardListSchema.describe('Not done on purpose.'),
  })
  .strict({ message: PLAN_NODE_CARD_KEYS_MESSAGE })
  .superRefine((card, ctx) => {
    const length = JSON.stringify(card).length;
    if (length > PLAN_NODE_CARD_MAX_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `This card holds ${String(length)} characters serialised, and a card holds at most ${String(PLAN_NODE_CARD_MAX_CHARS)}. Shorten its items: the plan document holds the full record.`,
      });
    }
  })
  .describe(
    'The decision card the operator decides from. Every section is required, and a list may be empty where you found none. One or two short sentences an item. Done when is the node’s criteria.',
  );
export type PlanNodeCard = z.infer<typeof PlanNodeCardSchema>;

/** A card the schema accepts, in its section order: how a write puts it in a patch. */
export function planNodeCardInOrder(card: PlanNodeCard): PlanNodeCard {
  return PlanNodeCardSchema.parse(card);
}

export type StoredPlanNodeCard = { card: PlanNodeCard } | { refusal: string };

/**
 * A stored card as a node read returns it. A `jsonb` column returns keys in
 * its own order, and a reader takes the card in D1's order. A card written
 * before a schema change may fail the schema now. The read then carries no
 * card and returns the refusal, so the node still passes its output schema.
 */
export function readStoredPlanNodeCard(stored: unknown): StoredPlanNodeCard {
  const parsed = PlanNodeCardSchema.safeParse(stored);
  return parsed.success ? { card: parsed.data } : { refusal: parsed.error.message };
}

/** What `plan.node.create` and `plan.node.update` say of the card they write. */
export const PLAN_NODE_CARD_WRITE_DESCRIPTION =
  'Write it on a node that asks the operator for a decision. A proposal carries one. Give every question the answer you recommend. A plan document you commission opens with this same card. Link the document to its node at the merge sha.';
export const PLAN_NODE_CARD_UPDATE_DESCRIPTION =
  'The card, as plan.node.create writes it. It replaces the whole card.';

export const PLAN_STREAM_SPEND_CENTS_MAX = 1_000_000;

const PlanNodeSpendCentsSchema = z
  .number()
  .int()
  .min(1)
  .max(PLAN_STREAM_SPEND_CENTS_MAX)
  .describe('The person-set spend ceiling in cents; only the operator open route may write it.');

export const PlanNodeSchema = z
  .object({
    nodeId: z.string().uuid(),
    spaceId: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
    kind: PlanNodeKindSchema,
    title: z.string(),
    goal: z.string().max(PLAN_NODE_PROSE_MAX_CHARS),
    criteria: z.string().max(PLAN_NODE_PROSE_MAX_CHARS),
    status: PlanNodeStatusSchema,
    /** How the criteria were met (done) or why the node was let go (dropped). */
    outcome: z.string().max(PLAN_NODE_PROSE_MAX_CHARS).optional(),
    note: z.string().max(PLAN_NODE_PROSE_MAX_CHARS).optional(),
    card: PlanNodeCardSchema.optional(),
    /** Name it as `expectedRevision` on the next update. */
    revision: z.number().int().min(1),
    position: z.number().int().min(0),
    /** The user behind the session that created the node. */
    createdBy: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    spendCents: PlanNodeSpendCentsSchema.optional(),
    closedAt: z.string().datetime().optional(),
  })
  .strict();
export type PlanNode = z.infer<typeof PlanNodeSchema>;

/** A node as a list or a tree shows it: enough to choose one and open it. */
export const PlanNodeSummarySchema = z
  .object({
    nodeId: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
    kind: PlanNodeKindSchema,
    title: z.string(),
    status: PlanNodeStatusSchema,
    revision: z.number().int().min(1),
    position: z.number().int().min(0),
    /** The note's first line. */
    noteHead: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    /** When it was marked done or dropped; absent while it is open. */
    closedAt: z.string().datetime().optional(),
  })
  .strict();
export type PlanNodeSummary = z.infer<typeof PlanNodeSummarySchema>;

// ============================================================================
// Writes
// ============================================================================

/**
 * The first lines the engine writes on a `blocked` node, each saying what it
 * waits on (Plan 331 D3, D5, D6, D8). A note that contains one of them
 * already states it, so an ask leaves it as it stands.
 */
export const PLAN_NODE_BLOCKED_HEAD = 'Blocked: ';
export const PLAN_NODE_PROPOSED_HEAD = 'Proposed: ';
export const PLAN_NODE_ASK_HEAD = 'Waiting on you: ';
export const PLAN_NODE_MERGE_WAIT_LINE =
  'Waiting on you: judge this merge because the scheduled close lacks a publication pull request that GitHub reports merged.';
export const PLAN_NODE_LIVE_CHECK_HEAD = `${PLAN_NODE_BLOCKED_HEAD}live check — `;

/** The line that says what a blocked node waits on, wherever it sits in the note. */
export function planNoteWaitLine(note: string | undefined): string | undefined {
  return note
    ?.split('\n')
    .find((line) =>
      [PLAN_NODE_BLOCKED_HEAD, PLAN_NODE_PROPOSED_HEAD, PLAN_NODE_ASK_HEAD].some((prefix) =>
        line.startsWith(prefix),
      ),
    );
}

/** A commit as git names it in full or abbreviated: what a live check asks the folder to hold. */
export const PlanCommitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/, { message: 'A commit is named by its hex sha, 7 to 64 characters.' });

/**
 * A node whose criteria need a merged change running on the operator's stack
 * (Plan 331 D8): it waits on a read of the connected folder's head holding
 * the merge, not on the merged node, which closes on its merge.
 */
export const PlanNodeLiveCheckSchema = z
  .object({
    pullRequest: z
      .string()
      .regex(/^https?:\/\/\S+$/, { message: 'The merged pull request’s URL.' })
      .describe('The merged pull request whose change the check needs running.'),
    mergeCommitSha: PlanCommitShaSchema.optional().describe(
      'The merge commit, where GitHub named it: what `host.binding.inspect` is asked the folder `holds`.',
    ),
  })
  .strict();
export type PlanNodeLiveCheck = z.infer<typeof PlanNodeLiveCheckSchema>;

export const PLAN_NODE_PROPOSAL_AND_LIVE_CHECK_MESSAGE =
  'A node is created as a proposal or as a live check, not both: a live check is not new scope, a proposal is.';
export const PLAN_NODE_LIVE_CHECK_KIND_MESSAGE = 'A live check must have kind `investigate`.';

export const PlanNodeCreateSchema = z
  .object({
    parentId: z.string().uuid().optional().describe('Omit for a root.'),
    kind: PlanNodeKindSchema,
    title: PlanNodeTitleSchema,
    goal: PlanNodeProseSchema,
    criteria: PlanNodeProseSchema.describe('How to tell the node is done.'),
    note: PlanNodeNoteSchema.optional(),
    position: PlanNodePositionSchema.optional(),
    card: PlanNodeCardSchema.optional().describe(PLAN_NODE_CARD_WRITE_DESCRIPTION),
    proposed: PlanNodeProseSchema.optional().describe(
      'Why this work is proposed. The node is created blocked, its note’s first line `Proposed: <why>`, and nothing starts from it until a person approves it. A resident wake creates nothing else.',
    ),
    liveCheck: PlanNodeLiveCheckSchema.optional().describe(
      'Where a merged node’s criteria need its change running on the stack: the node is created blocked on a read of the connected folder’s head holding the merge, and the merged node closes on its merge without waiting for it.',
    ),
  })
  .strict()
  .superRefine((create, ctx) => {
    if (create.proposed !== undefined && create.liveCheck !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['liveCheck'],
        message: PLAN_NODE_PROPOSAL_AND_LIVE_CHECK_MESSAGE,
      });
    }
    if (create.liveCheck !== undefined && create.kind !== 'investigate') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: PLAN_NODE_LIVE_CHECK_KIND_MESSAGE,
      });
    }
  });
export type PlanNodeCreate = z.infer<typeof PlanNodeCreateSchema>;

export const PLAN_NODE_DONE_NEEDS_OUTCOME_MESSAGE =
  'A node is done against its own criteria: pass `outcome` with how they were met, in the same update that sets status "done".';

export const PLAN_NODE_OPEN_HAS_NO_OUTCOME_MESSAGE =
  'An open node has no outcome: pass `outcome` with status "done" or "dropped", or leave it out. Reopening a node moves its outcome into the note.';

export const PLAN_NODE_UPDATE_EMPTY_MESSAGE =
  'This update changes nothing. Name at least one of status, note, goal, criteria, title, parentId, position, outcome or card.';

export const PLAN_NODE_UPDATE_FIELDS = [
  'status',
  'note',
  'goal',
  'criteria',
  'title',
  'parentId',
  'position',
  'outcome',
  'card',
] as const;
export const PlanNodeUpdateFieldSchema = z.enum(PLAN_NODE_UPDATE_FIELDS);
export type PlanNodeUpdateField = z.infer<typeof PlanNodeUpdateFieldSchema>;

export const PlanNodeUpdateSchema = z
  .object({
    nodeId: z.string().uuid(),
    expectedRevision: z
      .number()
      .int()
      .min(1)
      .describe('The revision the change was decided against.'),
    status: PlanNodeStatusSchema.optional(),
    note: PlanNodeNoteSchema.optional(),
    goal: PlanNodeProseSchema.optional(),
    criteria: PlanNodeProseSchema.optional(),
    title: PlanNodeTitleSchema.optional(),
    parentId: z.string().uuid().nullable().optional().describe('null makes it a root.'),
    position: PlanNodePositionSchema.optional(),
    outcome: PlanNodeProseSchema.optional().describe(
      'How the criteria were met, or why the node was dropped.',
    ),
    card: PlanNodeCardSchema.optional().describe(PLAN_NODE_CARD_UPDATE_DESCRIPTION),
  })
  .strict()
  .superRefine((update, ctx) => {
    if (update.status === 'done' && update.outcome === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: PLAN_NODE_DONE_NEEDS_OUTCOME_MESSAGE,
      });
    }
    if (
      update.status !== undefined &&
      !isClosedPlanNodeStatus(update.status) &&
      update.outcome !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: PLAN_NODE_OPEN_HAS_NO_OUTCOME_MESSAGE,
      });
    }
    if (PLAN_NODE_UPDATE_FIELDS.every((field) => update[field] === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: PLAN_NODE_UPDATE_EMPTY_MESSAGE });
    }
  });
export type PlanNodeUpdate = z.infer<typeof PlanNodeUpdateSchema>;

/**
 * The operator's write from the plan page (Plan 322 P3.2): close a node, done
 * or dropped, against the revision the page showed. It is a `plan.node.update`
 * the engine judges by the same rules — a stale revision is refused with the
 * current one — narrowed to what the page offers.
 */
export const PlanNodeCloseSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .min(1)
      .describe('The revision the page showed when the operator chose.'),
    status: z.enum(['done', 'dropped']),
    outcome: PlanNodeProseSchema.optional().describe(
      'How the criteria were met, or why the node was dropped.',
    ),
  })
  .strict()
  .superRefine((close, ctx) => {
    if (close.status === 'done' && close.outcome === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: PLAN_NODE_DONE_NEEDS_OUTCOME_MESSAGE,
      });
    }
  });
export type PlanNodeClose = z.infer<typeof PlanNodeCloseSchema>;

const ExpectedRevisionSchema = z
  .number()
  .int()
  .min(1)
  .describe('The revision the page showed when the operator chose.');

/** How long the operator's reason for an approve or a reopen may be: one line of a note. */
export const PLAN_NODE_OPEN_WHY_MAX_CHARS = PLAN_NODE_PROSE_MAX_CHARS;

/** The head the engine gives the operator's instructions on an approve. */
export const PLAN_NODE_APPROVED_HEAD = 'Approved: ';
/** The head the engine gives the operator's note on a revise (Plan 337 P4). */
export const PLAN_NODE_REVISE_HEAD = 'Revise: ';
/** The head of the line a Helmsman writes once it has rewritten a node from a revise. */
export const PLAN_NODE_REVISED_HEAD = 'Revised: ';
/** The label on the `session` link an operator's conversation leaves on a node it wrote. */
export const PLAN_NODE_CONVERSATION_LINK_LABEL = 'conversation';

/**
 * The operator's words as the engine writes them into a note: one line, so the
 * attention block, the rail's **Now** and a brief each read all of it as the
 * note's first line.
 */
export function planNodeOperatorLine(head: string, words: string): string {
  return `${head}${words.replace(/\s*[\r\n]+\s*/g, ' ').trim()}`;
}

/**
 * The operator's instructions a node carries: its note's first line, where the
 * engine wrote it there on an approve or a revise. A brief opens with it.
 */
export function planNodeInstructions(note: string | undefined): string | undefined {
  const first = note?.split('\n', 1)[0];
  if (first === undefined) return undefined;
  return first.startsWith(PLAN_NODE_APPROVED_HEAD) || first.startsWith(PLAN_NODE_REVISE_HEAD)
    ? first
    : undefined;
}

/**
 * The operator moves a `blocked`, `done` or `dropped` node to `active` (Plan
 * 332 D6): **Approve** on a blocked one, **Reopen** on a closed one. The engine
 * writes `why` into the note by its rule for each.
 */
export const PlanNodeOpenSchema = z
  .object({
    spendCents: PlanNodeSpendCentsSchema.optional(),
    expectedRevision: ExpectedRevisionSchema,
    why: z
      .string()
      .trim()
      .min(1)
      .max(PLAN_NODE_OPEN_WHY_MAX_CHARS)
      .optional()
      .describe(
        'On an approve, the operator’s instructions for the work: the note gains them as one `Approved: …` line, and the next brief opens with it. On a reopen, why; the note gains it as `Reopened: …`.',
      ),
  })
  .strict();
export type PlanNodeOpen = z.infer<typeof PlanNodeOpenSchema>;

/**
 * The operator sends a `blocked` node back for revision (Plan 337 P4). It stays
 * blocked. The engine writes `why` above the note as one `Revise: …` line, and
 * the write moves the revision, so whatever asked about the node asks again.
 */
export const PlanNodeReviseSchema = z
  .object({
    expectedRevision: ExpectedRevisionSchema,
    why: z
      .string()
      .trim()
      .min(1)
      .max(PLAN_NODE_OPEN_WHY_MAX_CHARS)
      .describe(
        'What to change in the proposal; the note gains it as `Revise: …`, and the Helmsman rewrites the node from it.',
      ),
  })
  .strict();
export type PlanNodeRevise = z.infer<typeof PlanNodeReviseSchema>;

const PlaceAnchorSchema = z.string().uuid();

/**
 * The operator puts a node directly before or after one of its siblings (Plan
 * 332 D6) — roots among roots. Never an absolute position: two operators
 * reordering at once would each overwrite the other's order unrefused.
 */
export const PlanNodePlaceSchema = z.union([
  z
    .object({
      expectedRevision: ExpectedRevisionSchema,
      before: PlaceAnchorSchema.describe('The sibling the node goes directly before.'),
    })
    .strict(),
  z
    .object({
      expectedRevision: ExpectedRevisionSchema,
      after: PlaceAnchorSchema.describe('The sibling the node goes directly after.'),
    })
    .strict(),
]);
export type PlanNodePlace = z.infer<typeof PlanNodePlaceSchema>;

/** One sibling as a refused place names it: the order as it stands, for the page to show. */
export const PlanNodeSiblingSchema = z
  .object({
    nodeId: z.string().uuid(),
    title: z.string(),
    status: PlanNodeStatusSchema,
    position: z.number().int().min(0),
  })
  .strict();
export type PlanNodeSibling = z.infer<typeof PlanNodeSiblingSchema>;

// ============================================================================
// Links (Plan 322 P1) — what did or holds a node's work
// ============================================================================

export const PlanNodeLinkKindSchema = z.enum([
  'run',
  'session',
  'pull_request',
  'document',
  'finding',
  'campaign',
  /** A merge of the node's pull request a stream's firing has judged the node against (Plan 322 P2b). */
  'merge',
]);
export type PlanNodeLinkKind = z.infer<typeof PlanNodeLinkKindSchema>;

/** Storage ceilings: a ref is an id, a URL or a path; a label is a line a person reads. */
export const PLAN_NODE_LINK_REF_MAX_CHARS = 2000;
export const PLAN_NODE_LINK_LABEL_MAX_CHARS = 500;

/** The kinds whose ref is a platform id. */
const UUID_REF_KINDS: readonly PlanNodeLinkKind[] = ['run', 'session', 'campaign'];
/** The kinds whose ref is a pull request's URL. */
const URL_REF_KINDS: readonly PlanNodeLinkKind[] = ['pull_request', 'merge'];

/**
 * The promoted run output a run names its pull request by. A run serving a
 * node that ends holding it links the pull request to the node.
 */
export const RUN_PULL_REQUEST_URL_OUTPUT = 'prUrl';

export const PlanNodeLinkCreateSchema = z
  .object({
    nodeId: z.string().uuid(),
    kind: PlanNodeLinkKindSchema,
    ref: z
      .string()
      .trim()
      .min(1)
      .max(PLAN_NODE_LINK_REF_MAX_CHARS)
      .describe(
        'What the link points at: the id of a run, session or campaign; the URL of a pull request; ' +
          'a memory path or URL for a document, a plan document’s at its merge sha; the finding’s own name for a finding; the merged pull request’s URL for a merge.',
      ),
    label: z.string().trim().min(1).max(PLAN_NODE_LINK_LABEL_MAX_CHARS).optional(),
  })
  .strict()
  .superRefine((link, ctx) => {
    if (UUID_REF_KINDS.includes(link.kind) && !z.string().uuid().safeParse(link.ref).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ref'],
        message: `A ${link.kind} link's ref is the ${link.kind}'s id, a UUID.`,
      });
    }
    if (URL_REF_KINDS.includes(link.kind) && !/^https?:\/\/\S+$/.test(link.ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ref'],
        message: `A ${link.kind} link’s ref is the pull request’s URL, as a person opens it.`,
      });
    }
  });
export type PlanNodeLinkCreate = z.infer<typeof PlanNodeLinkCreateSchema>;

export const PlanNodeLinkSchema = z
  .object({
    nodeId: z.string().uuid(),
    kind: PlanNodeLinkKindSchema,
    ref: z.string(),
    label: z.string().optional(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type PlanNodeLink = z.infer<typeof PlanNodeLinkSchema>;

// ============================================================================
// Dependencies (Plan 322 P2) — a node waits on another's outcome
// ============================================================================

/**
 * What the dependency's outcome must be for the edge to be met: `done` — it
 * met its criteria; `dropped` — it was let go (work that goes ahead only
 * where another approach was abandoned); `closed` — either.
 */
export const PlanNodeDependencyConditionSchema = z.enum(['done', 'dropped', 'closed']);
export type PlanNodeDependencyCondition = z.infer<typeof PlanNodeDependencyConditionSchema>;

/** Whether a dependency standing at `status` meets `condition`. */
export function planDependencyMet(
  condition: PlanNodeDependencyCondition,
  status: PlanNodeStatus,
): boolean {
  return condition === 'closed' ? isClosedPlanNodeStatus(status) : status === condition;
}

/** An edge as stored: `nodeId` waits on `dependsOnId`. */
export const PlanNodeDependencySchema = z
  .object({
    nodeId: z.string().uuid(),
    dependsOnId: z.string().uuid(),
    condition: PlanNodeDependencyConditionSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type PlanNodeDependency = z.infer<typeof PlanNodeDependencySchema>;

/** One end of an edge as `plan.node.get` shows it: the other node, and whether the edge is met. */
export const PlanNodeDependencyViewSchema = z
  .object({
    nodeId: z.string().uuid().describe('The node at the other end of the edge.'),
    title: z.string(),
    status: PlanNodeStatusSchema,
    condition: PlanNodeDependencyConditionSchema,
    met: z.boolean().describe('The dependency’s status meets the condition: `planDependencyMet`.'),
  })
  .strict();
export type PlanNodeDependencyView = z.infer<typeof PlanNodeDependencyViewSchema>;

// ============================================================================
// Learnings on a node (Plan 322 D8, P2)
// ============================================================================

/** A plan-scope learning as `plan.node.get` shows it. */
export const PlanNodeLearningSchema = z
  .object({
    learningId: z.string().uuid(),
    /** The node it was written on: the one opened, or one above it. */
    nodeId: z.string().uuid(),
    kind: CoachLearningKindSchema,
    statement: z.string(),
    confidence: CoachLearningSchema.shape.confidence,
    /** The runs it was learned from. */
    runIds: z.array(z.string().uuid()),
    createdAt: z.string().datetime(),
  })
  .strict();
export type PlanNodeLearning = z.infer<typeof PlanNodeLearningSchema>;

/** A run in flight for a node or one under it, as `plan.node.get` shows it. */
export const PlanNodeRunSchema = z
  .object({
    runId: z.string(),
    slug: z.string(),
    status: z.enum(['running', 'paused']),
    /** The node the run serves: the one opened, or one under it. */
    nodeId: z.string().uuid(),
    startedAt: z.string().datetime(),
  })
  .strict();
export type PlanNodeRun = z.infer<typeof PlanNodeRunSchema>;
