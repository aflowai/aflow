/**
 * The phase after P0 asks the operator to approve P0's merged design document
 * (Plan 339 D6), so that ask is written only once the document exists: the
 * plan's P0, its first step not dropped, has closed done with its design
 * document linked. The gate meets only the write that moves the node out of
 * blocked, reopens it, or lands or moves a blocked ask: the create that lands
 * the ask, an update from blocked to any other open status, an update from
 * done or dropped to an open one, an update that moves a node into blocked with the reason on
 * its card, an update that changes a blocked node's card to the reason, or an
 * update or a plan.node.place that moves a blocked ask to another parent or position.
 * It judges the node as that write lands it: its card, resent or stored, and
 * P0 among the siblings the write leaves.
 */
import {
  PLAN_NODE_POSITION_MAX,
  PLAN_TREE_DEPTH_LIMIT,
  isClosedPlanNodeStatus,
  type PlanNode,
  type PlanNodeCard,
  type PlanNodeStatus,
  type PlanNodeSummary,
  type PlanNodeWork,
} from '@aflow/schemas';
import type { PlanOpError, PlanReadContext } from './operations.js';
import { placeAmongSiblings, type PlanPlaceAnchor } from './placement.js';
import { bySiblingOrder } from './tree.js';

const P0_PAGE = 50;

/** A node as a create or an update leaves it. */
export interface PlanNodeLanding {
  /** Absent on a create: the node has no id until it is inserted. */
  nodeId?: string;
  work?: PlanNodeWork;
  /** The card the write sends, or the stored card where it sends none. */
  card?: PlanNodeCard;
  status: PlanNodeStatus;
  parentId: string | null;
  /** Absent: after its last sibling. */
  position?: number;
}

/** The root above `nodeId`, itself where it is one, or null where a node on the way is gone. */
async function planRootOf(ctx: PlanReadContext, nodeId: string): Promise<string | null> {
  let id = nodeId;
  for (let depth = 0; depth <= PLAN_TREE_DEPTH_LIMIT; depth++) {
    const parentId = (await ctx.store.parentsOf(ctx.spaceId, [id])).get(id);
    if (parentId === undefined) return null;
    if (parentId === null) return id;
    id = parentId;
  }
  return null;
}

/** The root's first stored child by position that is not dropped, the written node left out. */
async function storedP0Of(ctx: PlanReadContext, rootId: string, nodeId: string | undefined) {
  for (let offset = 0; ; offset += P0_PAGE) {
    const { children, total } = await ctx.store.listChildren(ctx.spaceId, rootId, P0_PAGE, offset);
    const p0 = children.find((child) => child.nodeId !== nodeId && child.status !== 'dropped');
    if (p0 !== undefined) return p0;
    if (children.length === 0 || offset + children.length >= total) return undefined;
  }
}

/**
 * Whether the written node stands ahead of `stored` once it lands. A create
 * at the same position is taken as ahead, since its id is drawn on insert.
 */
function landsAhead(
  landing: PlanNodeLanding,
  stored: { nodeId: string; position: number },
): boolean {
  if (landing.position === undefined) return false;
  if (landing.nodeId === undefined) return landing.position <= stored.position;
  return bySiblingOrder({ nodeId: landing.nodeId, position: landing.position }, stored) < 0;
}

async function designDocumentMerged(
  ctx: PlanReadContext,
  landing: PlanNodeLanding & { parentId: string },
): Promise<boolean> {
  const rootId = await planRootOf(ctx, landing.parentId);
  if (rootId === null) return false;
  const stored = await storedP0Of(ctx, rootId, landing.nodeId);
  // The asking node lands open, so where it stands first P0 has not closed.
  if (landing.parentId === rootId && (stored === undefined || landsAhead(landing, stored))) {
    return false;
  }
  if (stored?.status !== 'done') return false;
  return (await ctx.store.newestLink(ctx.spaceId, stored.nodeId, 'document')) !== null;
}

/**
 * The refusal of a create, or an update leaving blocked, reopening a closed
 * node, or landing or moving a blocked ask, that lands an open node asking for `design_approval`,
 * through its `work` or its card's `waitsOn`, before P0's design document has
 * merged.
 */
export async function designApprovalRefusal(
  ctx: PlanReadContext,
  landing: PlanNodeLanding,
): Promise<PlanOpError | undefined> {
  const asks =
    landing.work === 'design_approval' || landing.card?.waitsOn?.reason === 'design_approval';
  if (!asks || isClosedPlanNodeStatus(landing.status)) return undefined;
  const { parentId } = landing;
  if (parentId !== null && (await designDocumentMerged(ctx, { ...landing, parentId })))
    return undefined;
  return {
    ok: false,
    code: 'PLAN_NODE_DESIGN_NOT_MERGED',
    message:
      '`design_approval` asks the operator to approve a merged design document, and the plan’s P0, its first ' +
      'step not dropped, has not closed done with its design document linked, so nothing was written. Let P0 ' +
      'run active until its document merges, close it done and link the document at its merge sha, then write ' +
      'the phase that asks.',
  };
}

/**
 * The refusal of a plan.node.place that moves a blocked node whose card names
 * `design_approval`, judged against the siblings the placement leaves. A place
 * the store would not write (stale, not a sibling, unchanged) is left to it.
 */
export async function designApprovalPlaceRefusal(
  ctx: PlanReadContext,
  node: PlanNode,
  expectedRevision: number,
  anchor: PlanPlaceAnchor,
): Promise<PlanOpError | undefined> {
  if (node.revision !== expectedRevision || node.status !== 'blocked') return undefined;
  if (node.card?.waitsOn?.reason !== 'design_approval') return undefined;
  const siblings: PlanNodeSummary[] = [];
  for (let offset = 0; ; offset += P0_PAGE) {
    const page = await ctx.store.listChildren(ctx.spaceId, node.parentId, P0_PAGE, offset);
    siblings.push(...page.children);
    if (page.children.length === 0 || siblings.length >= page.total) break;
  }
  if (placeAmongSiblings(siblings, node.nodeId, anchor).outcome !== 'placed') return undefined;
  const others = siblings.filter((sibling) => sibling.nodeId !== node.nodeId);
  const anchorId = 'before' in anchor ? anchor.before : anchor.after;
  const anchorAt = others.findIndex((sibling) => sibling.nodeId === anchorId);
  const p0At = others.findIndex((sibling) => sibling.status !== 'dropped');
  const ahead = p0At === -1 || anchorAt + ('before' in anchor ? 0 : 1) <= p0At;
  // Before or past every stored position, so the gate reads the node's place against P0 exactly.
  return designApprovalRefusal(ctx, {
    nodeId: node.nodeId,
    card: node.card,
    status: node.status,
    parentId: node.parentId,
    position: ahead ? -1 : PLAN_NODE_POSITION_MAX + 1,
  });
}
