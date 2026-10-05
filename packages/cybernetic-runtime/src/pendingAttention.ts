import type { AttentionItemKind } from '@aflow/schemas';
import type { PendingRunAttention } from './ledger.js';
import type { PlanPlacement } from './plan/attention.js';

export interface PendingAttentionItemSummary {
  itemId: string;
  kind: AttentionItemKind;
  runId?: string;
  slug?: string;
  /** The conversation that drove the item's run. */
  sessionId?: string;
  /** Where the item's run sits in the plan. */
  plan?: PlanPlacement;
}

/**
 * The pending attention items the block shows a conversation of its own
 * under the plan, and of its own whose run serves no plan node, newest
 * first; `workflow.run.list_attention` reads every pending one.
 */
export const ATTENTION_ITEM_SURFACE_LIMIT = 10;

/**
 * The space's pending attention items, held for every conversation the
 * cached block renders for: each plan root's newest and each conversation's
 * newest placed in no plan, so whichever conversation reads the block, its
 * own newest are here, and every exact count, so the rest are counted rather
 * than sampled.
 */
export interface PendingAttention {
  /**
   * Newest first: up to `ATTENTION_ITEM_SURFACE_LIMIT` per plan root, and as
   * many per conversation of those placed in no plan.
   */
  items: PendingAttentionItemSummary[];
  totalsByRoot: Array<{ rootId: string; total: number }>;
  /**
   * Pending items whose run serves no node in the plan, by the conversation
   * that drove the run; `null` for those no conversation drove.
   */
  unplacedTotals: Array<{ sessionId: string | null; total: number }>;
}

/**
 * The pending items by the plan root their run serves, or the conversation
 * that drove a run serving none, each one's newest kept and every one counted.
 */
export function summarizePendingAttention(
  pending: PendingRunAttention,
  placements: ReadonlyMap<string, PlanPlacement>,
): PendingAttention | undefined {
  const placementOf = (nodeId: string | null) =>
    nodeId !== null ? placements.get(nodeId) : undefined;

  const totals = new Map<string, number>();
  const unplacedTotals = new Map<string | null, number>();
  for (const { planNodeId, sessionId, count } of pending.counts) {
    const rootId = placementOf(planNodeId)?.rootId;
    if (rootId === undefined) {
      unplacedTotals.set(sessionId, (unplacedTotals.get(sessionId) ?? 0) + count);
    } else {
      totals.set(rootId, (totals.get(rootId) ?? 0) + count);
    }
  }
  if (unplacedTotals.size === 0 && totals.size === 0) return undefined;

  const shownByRoot = new Map<string, number>();
  const shownBySession = new Map<string, number>();
  const items: PendingAttentionItemSummary[] = [];
  for (const item of pending.items) {
    const plan = placementOf(item.planNodeId);
    const shown = plan !== undefined ? shownByRoot : shownBySession;
    const key = plan !== undefined ? plan.rootId : item.sessionId;
    // An unplaced item no conversation drove is nobody's to read; it is only counted.
    if (key === null) continue;
    const kept = shown.get(key) ?? 0;
    if (kept >= ATTENTION_ITEM_SURFACE_LIMIT) continue;
    shown.set(key, kept + 1);
    items.push({
      itemId: item.itemId,
      kind: item.kind,
      ...(item.runId !== null ? { runId: item.runId } : {}),
      ...(item.workflowSlug !== null ? { slug: item.workflowSlug } : {}),
      ...(item.sessionId !== null ? { sessionId: item.sessionId } : {}),
      ...(plan !== undefined ? { plan } : {}),
    });
  }
  return {
    items,
    totalsByRoot: [...totals].map(([rootId, total]) => ({ rootId, total })),
    unplacedTotals: [...unplacedTotals].map(([sessionId, total]) => ({ sessionId, total })),
  };
}

/** Who reads the block: its session, and the plan roots its conversation has taken up. */
export interface AttentionReader {
  sessionId: string;
  planRootIds: ReadonlySet<string>;
}

/**
 * The pending items as one conversation reads them. An item is its own when
 * the conversation drove the item's run or, for a run placed in the plan, has
 * taken up the same root; it reads only its own, and every other one is
 * counted in `others`.
 */
export interface ConversationAttentionItems {
  /** Its own newest, under the plan roots it has taken up. */
  own: PendingAttentionItemSummary[];
  ownUnshown: number;
  /** Every pending item that is not this conversation's. */
  others: number;
  /** Its own newest whose run serves no plan node. */
  unplaced: PendingAttentionItemSummary[];
  unplacedUnshown: number;
  /** Whether any pending item is placed in the plan, whoever's. */
  placedAny: boolean;
}

export function pendingAttentionFor(
  pending: PendingAttention | undefined,
  reader: AttentionReader,
): ConversationAttentionItems {
  const items = pending?.items ?? [];
  const own = items
    .filter((item) => item.plan !== undefined && reader.planRootIds.has(item.plan.rootId))
    .slice(0, ATTENTION_ITEM_SURFACE_LIMIT);
  const unplaced = items
    .filter((item) => item.plan === undefined && item.sessionId === reader.sessionId)
    .slice(0, ATTENTION_ITEM_SURFACE_LIMIT);
  let ownTotal = 0;
  let unplacedTotal = 0;
  let others = 0;
  for (const { rootId, total } of pending?.totalsByRoot ?? []) {
    if (reader.planRootIds.has(rootId)) ownTotal += total;
    else others += total;
  }
  for (const { sessionId, total } of pending?.unplacedTotals ?? []) {
    if (sessionId === reader.sessionId) unplacedTotal += total;
    else others += total;
  }
  return {
    own,
    ownUnshown: ownTotal - own.length,
    others,
    unplaced,
    unplacedUnshown: unplacedTotal - unplaced.length,
    placedAny: (pending?.totalsByRoot.length ?? 0) > 0,
  };
}

/** The ids of the pending items a conversation's block shows it. */
export function renderedAttentionItemIds(items: ConversationAttentionItems): string[] {
  return [...items.own, ...items.unplaced].map((item) => item.itemId);
}
