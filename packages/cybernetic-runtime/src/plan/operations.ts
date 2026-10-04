/**
 * The plan engine (Plan 322 D7): the one authority over `plan_nodes`. The
 * orchestrator's `plan.node.*` inline ops call it, and so will the operator's
 * routes; each maps `{ ok: false, code, message, details }` onto its own
 * surface. Every write bumps the space's attention generation, so the next
 * turn of any session in the space reads the tree as it now stands.
 */
import type { Redis } from 'ioredis';
import {
  isClosedPlanNodeStatus,
  PLAN_NODE_CHILDREN_LIMIT,
  PLAN_NODE_LIST_DEFAULT_LIMIT,
  PLAN_TREE_DEPTH_LIMIT,
  PLAN_TREE_WALK_NODE_LIMIT,
  OPEN_PLAN_NODE_STATUSES,
  type PlanNode,
  type PlanNodeCreateInput,
  type PlanNodeGetOutput,
  type PlanNodeListInput,
  type PlanNodeListOutput,
  type PlanNodeStaleErrorDetails,
  type PlanNodeUpdateInput,
} from '@aflow/schemas';
import { bumpAttentionGeneration } from '../attentionCache.js';
import { orderPlanTree, type PlanTreeWalkBounds } from './tree.js';
import type { PlanNodeMove, PlanNodePatch, PlanNodeStore } from './store.js';

/** How far any read of a space's plan walks the tree. */
export const PLAN_TREE_WALK_BOUNDS: PlanTreeWalkBounds = {
  maxDepth: PLAN_TREE_DEPTH_LIMIT,
  maxNodes: PLAN_TREE_WALK_NODE_LIMIT,
};

export type PlanOpErrorCode =
  'PLAN_NODE_NOT_FOUND' | 'PLAN_NODE_STALE' | 'PLAN_NODE_CYCLE' | 'PLAN_NODE_TOO_DEEP';

export interface PlanOpError {
  ok: false;
  code: PlanOpErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type PlanOpResult<T> = ({ ok: true } & T) | PlanOpError;

export interface PlanReadContext {
  store: PlanNodeStore;
  spaceId: string;
}

export interface PlanWriteContext extends PlanReadContext {
  redis: Redis;
  tenantId: string;
  /** The user behind the writing session; recorded as `created_by` on a new node. */
  createdBy?: string;
}

function notFound(nodeId: string, role: 'node' | 'parent' | 'root' = 'node'): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_NOT_FOUND',
    message: `No plan node "${nodeId}" in this space${role === 'node' ? '' : ` to use as the ${role}`}. The attention block lists the open tree; plan.node.list finds the rest.`,
    details: { nodeId },
  };
}

function stale(current: PlanNode, expectedRevision: number): PlanOpError {
  const details: PlanNodeStaleErrorDetails = { currentRevision: current.revision, node: current };
  return {
    ok: false,
    code: 'PLAN_NODE_STALE',
    message:
      `Plan node "${current.title}" is at revision ${String(current.revision)}; this update was decided against revision ` +
      `${String(expectedRevision)}, so nothing was written. Its current state is in error.details.node — reconcile ` +
      `with it and update against revision ${String(current.revision)}.`,
    details: details as unknown as Record<string, unknown>,
  };
}

function cycle(nodeId: string, parentId: string): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_CYCLE',
    message: `Plan node "${parentId}" is "${nodeId}" itself or sits under it, so it cannot be its parent. Nothing was written.`,
    details: { nodeId, parentId },
  };
}

function tooDeep(nodeId: string, parentId: string): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_TOO_DEEP',
    message:
      `Plan node "${parentId}" sits ${String(PLAN_TREE_DEPTH_LIMIT)} or more levels below its root, so ` +
      `"${nodeId}" cannot go under it. Nothing was written; choose a parent nearer the root.`,
    details: { nodeId, parentId, depthLimit: PLAN_TREE_DEPTH_LIMIT },
  };
}

function moveRefusal(move: PlanNodeMove, nodeId: string, parentId: string): PlanOpError | null {
  switch (move.outcome) {
    case 'cycle':
      return cycle(nodeId, parentId);
    case 'too_deep':
      return tooDeep(nodeId, parentId);
    case 'parent_not_found':
      return notFound(parentId, 'parent');
    case 'moved':
    case 'stale':
      return null;
  }
}

async function written<T>(ctx: PlanWriteContext, value: T): Promise<T> {
  await bumpAttentionGeneration(ctx.redis, ctx.tenantId, ctx.spaceId);
  return value;
}

// ============================================================================
// plan.node.create
// ============================================================================

export async function createPlanNode(
  ctx: PlanWriteContext,
  input: PlanNodeCreateInput,
): Promise<PlanOpResult<{ node: PlanNode }>> {
  const parentId = input.parentId ?? null;
  if (parentId !== null && !(await ctx.store.find(ctx.spaceId, parentId))) {
    return notFound(parentId, 'parent');
  }
  const position = input.position ?? (await ctx.store.nextPosition(ctx.spaceId, parentId));
  const node = await ctx.store.insert(ctx.spaceId, {
    parentId,
    kind: input.kind,
    title: input.title,
    goal: input.goal,
    criteria: input.criteria,
    note: input.note !== undefined && input.note !== '' ? input.note : null,
    position,
    createdBy: ctx.createdBy ?? null,
  });
  return written(ctx, { ok: true as const, node });
}

// ============================================================================
// plan.node.update — compare-and-set on the node's revision (Plan 322 D6)
// ============================================================================

export async function updatePlanNode(
  ctx: PlanWriteContext,
  input: PlanNodeUpdateInput,
): Promise<PlanOpResult<{ node: PlanNode }>> {
  const current = await ctx.store.find(ctx.spaceId, input.nodeId);
  if (!current) return notFound(input.nodeId);
  if (current.revision !== input.expectedRevision) return stale(current, input.expectedRevision);

  const patch: PlanNodePatch = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.criteria !== undefined) patch.criteria = input.criteria;
  if (input.note !== undefined) patch.note = input.note === '' ? null : input.note;
  if (input.outcome !== undefined) patch.outcome = input.outcome;
  if (input.position !== undefined) patch.position = input.position;

  if (input.status !== undefined) {
    patch.status = input.status;
    if (!isClosedPlanNodeStatus(input.status)) patch.closedAt = null;
    else if (current.closedAt === undefined) patch.closedAt = new Date();
  }

  const parentId = input.parentId;
  let node: PlanNode | null;
  if (parentId !== undefined && parentId !== current.parentId) {
    const move = await ctx.store.moveAtRevision(
      ctx.spaceId,
      input.nodeId,
      input.expectedRevision,
      parentId,
      patch,
    );
    const refusal = parentId === null ? null : moveRefusal(move, input.nodeId, parentId);
    if (refusal) return refusal;
    node = move.outcome === 'moved' ? move.node : null;
  } else {
    node = await ctx.store.updateAtRevision(
      ctx.spaceId,
      input.nodeId,
      input.expectedRevision,
      patch,
    );
  }
  if (!node) {
    // Another session wrote between the read and this write.
    const now = await ctx.store.find(ctx.spaceId, input.nodeId);
    return now ? stale(now, input.expectedRevision) : notFound(input.nodeId);
  }
  return written(ctx, { ok: true as const, node });
}

// ============================================================================
// plan.node.get / plan.node.list
// ============================================================================

export async function getPlanNode(
  ctx: PlanReadContext,
  nodeId: string,
): Promise<PlanOpResult<PlanNodeGetOutput>> {
  const node = await ctx.store.find(ctx.spaceId, nodeId);
  if (!node) return notFound(nodeId);
  const { children, total } = await ctx.store.listChildren(
    ctx.spaceId,
    nodeId,
    PLAN_NODE_CHILDREN_LIMIT,
  );
  return { ok: true, node, children, childrenTotal: total };
}

export async function listPlanNodes(
  ctx: PlanReadContext,
  input: Partial<PlanNodeListInput>,
): Promise<PlanOpResult<PlanNodeListOutput>> {
  const statuses = new Set(input.status ?? OPEN_PLAN_NODE_STATUSES);
  const limit = input.limit ?? PLAN_NODE_LIST_DEFAULT_LIMIT;

  const start = input.rootId !== undefined ? { rootId: input.rootId } : {};
  if (start.rootId !== undefined && !(await ctx.store.find(ctx.spaceId, start.rootId))) {
    return notFound(start.rootId, 'root');
  }
  const walk = await ctx.store.walk(ctx.spaceId, { ...start, ...PLAN_TREE_WALK_BOUNDS });
  const matching = orderPlanTree(walk.nodes, start)
    .map((placed) => placed.node)
    .filter((node) => statuses.has(node.status));

  // A bound the walk met hides nodes whatever `limit` is, so it is the one to name.
  const truncated =
    walk.truncated ??
    (matching.length > limit ? { bound: 'limit' as const, value: limit } : undefined);
  return {
    ok: true,
    nodes: matching.slice(0, limit),
    ...(truncated !== undefined ? { truncated } : {}),
  };
}
