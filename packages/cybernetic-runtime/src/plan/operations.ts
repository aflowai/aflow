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
  PLAN_NODE_PROSE_MAX_CHARS,
  PLAN_NODE_UPDATE_FIELDS,
  PLAN_TREE_DEPTH_LIMIT,
  PLAN_TREE_WALK_NODE_LIMIT,
  OPEN_PLAN_NODE_STATUSES,
  type PlanNode,
  type PlanNodeCreateInput,
  type PlanNodeGetOutput,
  type PlanNodeListInput,
  type PlanNodeListOutput,
  type PlanNodeRefusalDetails,
  type PlanNodeStatus,
  type PlanNodeUpdateInput,
} from '@aflow/schemas';
import { bumpAttentionGeneration } from '../attentionCache.js';
import { orderPlanTree, type PlanTreeWalkBounds } from './tree.js';
import type { PlanNodePatch, PlanNodeStore, PlanPlacementRefusal } from './store.js';

/** How far any read of a space's plan walks the tree. */
export const PLAN_TREE_WALK_BOUNDS: PlanTreeWalkBounds = {
  maxDepth: PLAN_TREE_DEPTH_LIMIT,
  maxNodes: PLAN_TREE_WALK_NODE_LIMIT,
};

export type PlanOpErrorCode =
  | 'PLAN_NODE_NOT_FOUND'
  | 'PLAN_NODE_STALE'
  | 'PLAN_NODE_CYCLE'
  | 'PLAN_NODE_TOO_DEEP'
  | 'PLAN_NODE_OPEN_HAS_NO_OUTCOME'
  | 'PLAN_NODE_UNCHANGED'
  | 'PLAN_NODE_NOTE_TOO_LONG';

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

/** A patch column against the node's: absent is null, and a time compares as its ISO string. */
function sameColumn(patched: unknown, held: unknown): boolean {
  const stored = (value: unknown) =>
    value instanceof Date ? value.toISOString() : (value ?? null);
  return stored(patched) === stored(held);
}

function refusalDetails(current: PlanNode, input: PlanNodeUpdateInput): Record<string, unknown> {
  const differingFields = PLAN_NODE_UPDATE_FIELDS.filter((field) => {
    const value = field === 'note' && input.note === '' ? null : input[field];
    return value !== undefined && !sameColumn(value, current[field]);
  });
  const details: PlanNodeRefusalDetails = {
    nodeId: current.nodeId,
    revision: current.revision,
    status: current.status,
    updatedAt: current.updatedAt,
    differingFields,
  };
  return details;
}

function stale(current: PlanNode, input: PlanNodeUpdateInput): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_STALE',
    message:
      `Plan node "${current.title}" is at revision ${String(current.revision)}; this update was decided against revision ` +
      `${String(input.expectedRevision)}, so nothing was written. error.details.differingFields names what this update ` +
      `would still change; read the node with plan.node.get, reconcile with it, and update against revision ` +
      `${String(current.revision)}.`,
    details: refusalDetails(current, input),
  };
}

function openHasNoOutcome(current: PlanNode, status: PlanNodeStatus): PlanOpError {
  const stands =
    status === current.status ? `is ${status}` : `would be ${status} after this update`;
  return {
    ok: false,
    code: 'PLAN_NODE_OPEN_HAS_NO_OUTCOME',
    message:
      `Plan node "${current.title}" ${stands}, and an open node has no outcome, so nothing was written. ` +
      'Pass `outcome` in the update that sets status "done" or "dropped", or put what you found in the note.',
    details: { nodeId: current.nodeId, status },
  };
}

function unchanged(current: PlanNode, input: PlanNodeUpdateInput): PlanOpError {
  return {
    ok: false,
    code: 'PLAN_NODE_UNCHANGED',
    message:
      `Plan node "${current.title}" already stands as this update would leave it, so nothing was written ` +
      `and it stays at revision ${String(current.revision)}. An update names at least one field whose value ` +
      'differs from the node; plan.node.get reads it as it stands.',
    details: refusalDetails(current, input),
  };
}

function reopenedNoteTooLong(current: PlanNode, noteLength: number): PlanOpError {
  const headLength = reopenedNote(current, null)?.length ?? 0;
  const room = PLAN_NODE_PROSE_MAX_CHARS - headLength - 1;
  const shortenOutcome = `shorten the outcome with an update while the node is still ${current.status}`;
  const remedy =
    headLength > PLAN_NODE_PROSE_MAX_CHARS
      ? `Its outcome alone passes that: ${shortenOutcome}, then reopen it.`
      : `Pass a shorter \`note\` in this update${room > 0 ? ` (at most ${String(room)} characters fit under the reopened line)` : ''}, ` +
        `or "" to keep only that line, or ${shortenOutcome} first.`;
  return {
    ok: false,
    code: 'PLAN_NODE_NOTE_TOO_LONG',
    message:
      `Reopening plan node "${current.title}" puts its outcome at the head of its note, which would then hold ` +
      `${String(noteLength)} characters; a note holds at most ${String(PLAN_NODE_PROSE_MAX_CHARS)}, so nothing was ` +
      `written. ${remedy}`,
    details: { nodeId: current.nodeId, noteLength, noteMaxChars: PLAN_NODE_PROSE_MAX_CHARS },
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

type TooDeep = Extract<PlanPlacementRefusal, { outcome: 'too_deep' }>;

/** `nodeId` is null for a node not yet created. */
function tooDeep(nodeId: string | null, parentId: string, check: TooDeep): PlanOpError {
  const deepest = check.parentDepth + 1 + check.height;
  const placed =
    nodeId === null
      ? `a new node under it would sit at depth ${String(deepest)}`
      : `"${nodeId}" has ${String(check.height)} level${check.height === 1 ? '' : 's'} below it, so moving it there would put its deepest node at depth ${String(deepest)}`;
  return {
    ok: false,
    code: 'PLAN_NODE_TOO_DEEP',
    message:
      `Plan node "${parentId}" sits at depth ${String(check.parentDepth)} (a root is depth 0) and ${placed}; ` +
      `a plan holds nodes to depth ${String(PLAN_TREE_DEPTH_LIMIT)}. Nothing was written; choose a parent nearer the root.`,
    details: {
      ...(nodeId !== null ? { nodeId } : {}),
      parentId,
      parentDepth: check.parentDepth,
      height: check.height,
      depthLimit: PLAN_TREE_DEPTH_LIMIT,
    },
  };
}

function placementRefusal(
  refusal: PlanPlacementRefusal,
  nodeId: string | null,
  parentId: string,
): PlanOpError {
  switch (refusal.outcome) {
    case 'cycle':
      if (nodeId === null) throw new Error('a placement check met a node not yet created');
      return cycle(nodeId, parentId);
    case 'too_deep':
      return tooDeep(nodeId, parentId, refusal);
    case 'parent_not_found':
      return notFound(parentId, 'parent');
  }
}

/** A reopened node keeps what it claimed, as the head of its note, not as its outcome. */
function reopenedNote(
  current: PlanNode,
  note: string | null | undefined,
): string | null | undefined {
  if (current.outcome === undefined) return note;
  const kept = `Reopened; it was ${current.status}: ${current.outcome}`;
  const rest = note === undefined ? (current.note ?? null) : note;
  return rest === null ? kept : `${kept}\n${rest}`;
}

function changesNothing(
  current: PlanNode,
  patch: PlanNodePatch,
  parentId: string | null | undefined,
): boolean {
  return (
    (parentId === undefined || parentId === current.parentId) &&
    Object.entries(patch).every(([column, value]) =>
      sameColumn(value, current[column as keyof PlanNodePatch]),
    )
  );
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
  const position = input.position ?? (await ctx.store.nextPosition(ctx.spaceId, parentId));
  const inserted = await ctx.store.insert(ctx.spaceId, {
    parentId,
    kind: input.kind,
    title: input.title,
    goal: input.goal,
    criteria: input.criteria,
    note: input.note !== undefined && input.note !== '' ? input.note : null,
    position,
    createdBy: ctx.createdBy ?? null,
  });
  if (inserted.outcome === 'inserted') {
    return written(ctx, { ok: true as const, node: inserted.node });
  }
  if (parentId === null) throw new Error('the plan store refused a place to a root');
  return placementRefusal(inserted, null, parentId);
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
  if (current.revision !== input.expectedRevision) return stale(current, input);
  // The refusals below judge `current`, and the write lands only on its
  // revision: a node changed since this read is refused as stale instead.
  const status = input.status ?? current.status;
  if (input.outcome !== undefined && !isClosedPlanNodeStatus(status)) {
    return openHasNoOutcome(current, status);
  }

  const patch: PlanNodePatch = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.criteria !== undefined) patch.criteria = input.criteria;
  if (input.note !== undefined) patch.note = input.note === '' ? null : input.note;
  if (input.outcome !== undefined) patch.outcome = input.outcome;
  if (input.position !== undefined) patch.position = input.position;

  if (input.status !== undefined) {
    patch.status = input.status;
    if (!isClosedPlanNodeStatus(input.status)) {
      patch.closedAt = null;
      if (isClosedPlanNodeStatus(current.status)) {
        const note = reopenedNote(current, patch.note);
        if (typeof note === 'string' && note.length > PLAN_NODE_PROSE_MAX_CHARS) {
          return reopenedNoteTooLong(current, note.length);
        }
        if (note !== undefined) patch.note = note;
        patch.outcome = null;
      }
    } else if (current.closedAt === undefined) patch.closedAt = new Date();
  }

  const parentId = input.parentId;
  if (changesNothing(current, patch, parentId)) return unchanged(current, input);
  let node: PlanNode | null;
  if (parentId !== undefined && parentId !== current.parentId) {
    const move = await ctx.store.moveAtRevision(
      ctx.spaceId,
      input.nodeId,
      input.expectedRevision,
      parentId,
      patch,
    );
    if (move.outcome === 'moved') node = move.node;
    else if (move.outcome === 'stale') node = null;
    else if (parentId === null) throw new Error('the plan store refused a move to the root');
    else return placementRefusal(move, input.nodeId, parentId);
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
    return now ? stale(now, input) : notFound(input.nodeId);
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
  // A list of open nodes walks through open nodes only, so the walk's node
  // ceiling counts what the caller is shown rather than closed history.
  const openOnly = [...statuses].every((status) => !isClosedPlanNodeStatus(status));
  const walk = await ctx.store.walk(ctx.spaceId, {
    ...start,
    ...(openOnly ? { statuses: OPEN_PLAN_NODE_STATUSES } : {}),
    ...PLAN_TREE_WALK_BOUNDS,
  });
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
