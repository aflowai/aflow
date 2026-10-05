import type { AttentionItemKind } from '@aflow/schemas';
import type { PendingRunAttention } from './ledger.js';
import type { PlanPlacement } from './plan/attention.js';

export interface PendingAttentionItemSummary {
  itemId: string;
  kind: AttentionItemKind;
  runId?: string;
  slug?: string;
  /** Where the item's run sits in the plan. */
  plan?: PlanPlacement;
}

/**
 * The pending attention items the block shows of a conversation's own, and
 * of those whose run serves no plan node, newest first;
 * `workflow.run.list_attention` reads them all.
 */
export const ATTENTION_ITEM_SURFACE_LIMIT = 10;

/**
 * The space's pending attention items, held for every conversation the
 * cached block renders for: each plan root's newest, so whichever roots a
 * conversation has taken up, its own newest are here, and every root's exact
 * count, so the rest are counted rather than sampled.
 */
export interface PendingAttention {
  /** Newest first: up to `ATTENTION_ITEM_SURFACE_LIMIT` per plan root, and as many placed in no plan. */
  items: PendingAttentionItemSummary[];
  totalsByRoot: Array<{ rootId: string; total: number }>;
  /** Pending items whose run serves no node in the plan. */
  unplacedTotal: number;
}

/** The pending items by the plan root their run serves, each root's newest kept and every one counted. */
export function summarizePendingAttention(
  pending: PendingRunAttention,
  placements: ReadonlyMap<string, PlanPlacement>,
): PendingAttention | undefined {
  const placementOf = (nodeId: string | null) =>
    nodeId !== null ? placements.get(nodeId) : undefined;

  const totals = new Map<string, number>();
  let unplacedTotal = 0;
  for (const { planNodeId, count } of pending.counts) {
    const rootId = placementOf(planNodeId)?.rootId;
    if (rootId === undefined) unplacedTotal += count;
    else totals.set(rootId, (totals.get(rootId) ?? 0) + count);
  }
  if (unplacedTotal === 0 && totals.size === 0) return undefined;

  const shown = new Map<string | undefined, number>();
  const items: PendingAttentionItemSummary[] = [];
  for (const item of pending.items) {
    const plan = placementOf(item.planNodeId);
    const kept = shown.get(plan?.rootId) ?? 0;
    if (kept >= ATTENTION_ITEM_SURFACE_LIMIT) continue;
    shown.set(plan?.rootId, kept + 1);
    items.push({
      itemId: item.itemId,
      kind: item.kind,
      ...(item.runId !== null ? { runId: item.runId } : {}),
      ...(item.workflowSlug !== null ? { slug: item.workflowSlug } : {}),
      ...(plan !== undefined ? { plan } : {}),
    });
  }
  return {
    items,
    totalsByRoot: [...totals].map(([rootId, total]) => ({ rootId, total })),
    unplacedTotal,
  };
}

/** The pending items as one conversation reads them. */
export interface ConversationAttentionItems {
  /** Its own newest, under the plan roots it has taken up. */
  own: PendingAttentionItemSummary[];
  ownUnshown: number;
  /** Every pending item under another root. */
  others: number;
  unplaced: PendingAttentionItemSummary[];
  unplacedUnshown: number;
  /** Whether any pending item is placed in the plan, whoever's. */
  placedAny: boolean;
}

export function pendingAttentionFor(
  pending: PendingAttention | undefined,
  ownRoots: ReadonlySet<string>,
): ConversationAttentionItems {
  const items = pending?.items ?? [];
  const own = items
    .filter((item) => item.plan !== undefined && ownRoots.has(item.plan.rootId))
    .slice(0, ATTENTION_ITEM_SURFACE_LIMIT);
  const unplaced = items.filter((item) => item.plan === undefined);
  let ownTotal = 0;
  let others = 0;
  for (const { rootId, total } of pending?.totalsByRoot ?? []) {
    if (ownRoots.has(rootId)) ownTotal += total;
    else others += total;
  }
  return {
    own,
    ownUnshown: ownTotal - own.length,
    others,
    unplaced,
    unplacedUnshown: (pending?.unplacedTotal ?? 0) - unplaced.length,
    placedAny: unplaced.length < items.length,
  };
}
