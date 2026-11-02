/**
 * The phase after P0 asks the operator to approve P0's merged design document
 * (Plan 339 D6), so that ask is written only once the document exists: the
 * plan's P0, its first step not dropped, has closed done with its design
 * document linked. The gate meets only the write that moves the node out of
 * blocked: the create that lands the ask, or the update that turns it active.
 * It judges the node as that write lands it: its card, resent or stored, and
 * P0 among the siblings the write leaves.
 */
import {
  PLAN_TREE_DEPTH_LIMIT,
  isClosedPlanNodeStatus,
  type PlanNodeCard,
  type PlanNodeStatus,
  type PlanNodeWork,
} from '@aflow/schemas';
import type { PlanOpError, PlanReadContext } from './operations.js';
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
 * The refusal of a create, or an update from blocked to active, that lands an
 * open node asking for `design_approval`,
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
