/**
 * The phase after P0 asks the operator to approve P0's merged design document
 * (Plan 339 D6), so it is created only once that document exists: a step
 * beside it has closed done with its document linked.
 */
import type { PlanNodeWork } from '@aflow/schemas';
import type { PlanOpError, PlanReadContext } from './operations.js';

const SIBLINGS_PAGE = 100;

async function designDocumentMerged(ctx: PlanReadContext, parentId: string): Promise<boolean> {
  for (let offset = 0; ; offset += SIBLINGS_PAGE) {
    const page = await ctx.store.listChildren(ctx.spaceId, parentId, SIBLINGS_PAGE, offset);
    for (const sibling of page.children) {
      if (sibling.status !== 'done') continue;
      if ((await ctx.store.newestLink(ctx.spaceId, sibling.nodeId, 'document')) !== null) {
        return true;
      }
    }
    if (page.children.length === 0 || offset + page.children.length >= page.total) return false;
  }
}

/** The refusal of a `design_approval` create before its design document has merged. */
export async function designApprovalRefusal(
  ctx: PlanReadContext,
  work: PlanNodeWork | undefined,
  parentId: string | null,
): Promise<PlanOpError | undefined> {
  if (work !== 'design_approval') return undefined;
  if (parentId !== null && (await designDocumentMerged(ctx, parentId))) return undefined;
  return {
    ok: false,
    code: 'PLAN_NODE_DESIGN_NOT_MERGED',
    message:
      '`design_approval` asks the operator to approve a merged design document, and no step beside this one ' +
      'has closed done with its document linked, so nothing was written. Let P0 run active until its document ' +
      'merges, close it done and link the document at its merge sha, then create the phase that asks.',
  };
}
