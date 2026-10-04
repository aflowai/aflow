import { z } from 'zod';
import { buildOperationId } from '../../catalog/operationId.js';
import {
  OPEN_PLAN_NODE_STATUSES,
  PlanNodeCreateSchema,
  PlanNodeSchema,
  PlanNodeStatusSchema,
  PlanNodeSummarySchema,
  PlanNodeUpdateSchema,
} from '../../cybernetic/plan.js';

export const PLAN_NODE_CREATE_OPERATION_ID = buildOperationId('plan', 'node', 'create');
export const PLAN_NODE_UPDATE_OPERATION_ID = buildOperationId('plan', 'node', 'update');
export const PLAN_NODE_GET_OPERATION_ID = buildOperationId('plan', 'node', 'get');
export const PLAN_NODE_LIST_OPERATION_ID = buildOperationId('plan', 'node', 'list');

export const PLAN_NODE_LIST_DEFAULT_LIMIT = 50;
export const PLAN_NODE_LIST_MAX_LIMIT = 200;
/** Children `plan.node.get` returns; `plan.node.list` with `rootId` reaches the rest. */
export const PLAN_NODE_CHILDREN_LIMIT = 100;
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

/** `error.details` for `PLAN_NODE_STALE`: the node as it stands now. */
export const PlanNodeStaleErrorDetailsSchema = z
  .object({
    currentRevision: z.number().int().min(1),
    node: PlanNodeSchema,
  })
  .strict();
export type PlanNodeStaleErrorDetails = z.infer<typeof PlanNodeStaleErrorDetailsSchema>;

/** `error.details` for `PLAN_NODE_UNCHANGED`: the node, already as the update would leave it. */
export const PlanNodeUnchangedErrorDetailsSchema = z.object({ node: PlanNodeSchema }).strict();
export type PlanNodeUnchangedErrorDetails = z.infer<typeof PlanNodeUnchangedErrorDetailsSchema>;

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
});
export type PlanNodeGetOutput = z.infer<typeof PlanNodeGetOutputSchema>;

export const PlanNodeListInputSchema = z
  .object({
    status: z
      .array(PlanNodeStatusSchema)
      .min(1)
      .default([...OPEN_PLAN_NODE_STATUSES])
      .describe(
        'Defaults to the open statuses. Open statuses alone read through open nodes only, so a node under a closed one is listed by naming that closed status too.',
      ),
    rootId: z.string().uuid().optional().describe('Only this node and those under it.'),
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
