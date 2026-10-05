import { z } from 'zod';

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
export const PLAN_NODE_PROSE_MAX_CHARS = 8000;

const PlanNodeTitleSchema = z.string().trim().min(1).max(PLAN_NODE_TITLE_MAX_CHARS);
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
    /** Name it as `expectedRevision` on the next update. */
    revision: z.number().int().min(1),
    position: z.number().int().min(0),
    /** The user behind the session that created the node. */
    createdBy: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
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
    updatedAt: z.string().datetime(),
  })
  .strict();
export type PlanNodeSummary = z.infer<typeof PlanNodeSummarySchema>;

// ============================================================================
// Writes
// ============================================================================

export const PlanNodeCreateSchema = z
  .object({
    parentId: z.string().uuid().optional().describe('Omit for a root.'),
    kind: PlanNodeKindSchema,
    title: PlanNodeTitleSchema,
    goal: PlanNodeProseSchema,
    criteria: PlanNodeProseSchema.describe('How to tell the node is done.'),
    note: PlanNodeNoteSchema.optional(),
    position: PlanNodePositionSchema.optional(),
  })
  .strict();
export type PlanNodeCreate = z.infer<typeof PlanNodeCreateSchema>;

export const PLAN_NODE_DONE_NEEDS_OUTCOME_MESSAGE =
  'A node is done against its own criteria: pass `outcome` with how they were met, in the same update that sets status "done".';

export const PLAN_NODE_OPEN_HAS_NO_OUTCOME_MESSAGE =
  'An open node has no outcome: pass `outcome` with status "done" or "dropped", or leave it out. Reopening a node moves its outcome into the note.';

export const PLAN_NODE_UPDATE_EMPTY_MESSAGE =
  'This update changes nothing. Name at least one of status, note, criteria, title, parentId, position or outcome.';

export const PLAN_NODE_UPDATE_FIELDS = [
  'status',
  'note',
  'criteria',
  'title',
  'parentId',
  'position',
  'outcome',
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
    criteria: PlanNodeProseSchema.optional(),
    title: PlanNodeTitleSchema.optional(),
    parentId: z.string().uuid().nullable().optional().describe('null makes it a root.'),
    position: PlanNodePositionSchema.optional(),
    outcome: PlanNodeProseSchema.optional().describe(
      'How the criteria were met, or why the node was dropped.',
    ),
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
