/**
 * The phase after P0 asks the operator to approve P0's merged design document
 * (Plan 339 D6), so that ask is created only once the document exists: the
 * plan's P0, its first step, has closed done with its design document linked.
 */
import type { PlanNodeCreateInput } from '@aflow/schemas';
import type { PlanOpError, PlanReadContext } from './operations.js';

async function designDocumentMerged(ctx: PlanReadContext, planId: string): Promise<boolean> {
  const { children } = await ctx.store.listChildren(ctx.spaceId, planId, 1);
  const p0 = children[0];
  if (p0?.status !== 'done') return false;
  return (await ctx.store.newestLink(ctx.spaceId, p0.nodeId, 'document')) !== null;
}

/**
 * The refusal of a create that asks for `design_approval`, through its `work`
 * or its card's `waitsOn`, before P0's design document has merged.
 */
export async function designApprovalRefusal(
  ctx: PlanReadContext,
  input: Pick<PlanNodeCreateInput, 'work' | 'card'>,
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
      'step, has not closed done with its design document linked, so nothing was written. Let P0 run active ' +
      'until its document merges, close it done and link the document at its merge sha, then create the phase ' +
      'that asks.',
  };
}
