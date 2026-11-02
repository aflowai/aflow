/**
 * The phase after P0 asks the operator to approve P0's merged design document
 * (Plan 339 D6), so that ask is written only once the document exists: the
 * plan's P0, its first step not dropped, has closed done with its design
 * document linked.
 */
import { PLAN_TREE_DEPTH_LIMIT, type PlanNodeCreateInput } from '@aflow/schemas';
import type { PlanOpError, PlanReadContext } from './operations.js';

const P0_PAGE = 50;

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

/** The root's first child by position that is not dropped. */
async function p0Of(ctx: PlanReadContext, rootId: string) {
  for (let offset = 0; ; offset += P0_PAGE) {
    const { children, total } = await ctx.store.listChildren(ctx.spaceId, rootId, P0_PAGE, offset);
    const p0 = children.find((child) => child.status !== 'dropped');
    if (p0 !== undefined) return p0;
    if (children.length === 0 || offset + children.length >= total) return undefined;
  }
}

async function designDocumentMerged(ctx: PlanReadContext, parentId: string): Promise<boolean> {
  const rootId = await planRootOf(ctx, parentId);
  if (rootId === null) return false;
  const p0 = await p0Of(ctx, rootId);
  if (p0?.status !== 'done') return false;
  return (await ctx.store.newestLink(ctx.spaceId, p0.nodeId, 'document')) !== null;
}

/**
 * The refusal of a create or an update that asks for `design_approval`,
 * through its `work` or its card's `waitsOn`, before P0's design document has
 * merged. `parentId` is the node's parent once the write lands.
 */
export async function designApprovalRefusal(
  ctx: PlanReadContext,
  input: Partial<Pick<PlanNodeCreateInput, 'work' | 'card'>>,
  parentId: string | null,
): Promise<PlanOpError | undefined> {
  const asks =
    input.work === 'design_approval' || input.card?.waitsOn?.reason === 'design_approval';
  if (!asks) return undefined;
  if (parentId !== null && (await designDocumentMerged(ctx, parentId))) return undefined;
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
