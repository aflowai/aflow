import type { AttentionItemKind } from '@aflow/schemas';
import { isReadersWork, type AttentionReader, type OwnedWork } from './conversationOwnership.js';
import type { PendingRunAttention } from './ledger.js';
import type { PlanPlacement } from './plan/attention.js';

export interface PendingAttentionItemSummary extends OwnedWork {
  itemId: string;
  kind: AttentionItemKind;
  runId?: string;
  slug?: string;
  /** Where the item's run sits in the plan. */
  plan?: PlanPlacement;
}

/**
 * The pending attention items the block shows a conversation of its own
 * under the plan, and of its own whose run serves no plan node, newest
 * first; `workflow.run.list_attention` reads every one of its own.
 */
export const ATTENTION_ITEM_SURFACE_LIMIT = 10;

/** Pending items counted by where their run sits and who drove it. */
export interface PendingAttentionTotal extends OwnedWork {
  plan?: PlanPlacement;
  total: number;
}

/**
 * The space's pending attention items, held for every conversation the
 * cached block renders for: each plan root's newest, each live
 * conversation's newest placed in no plan, and the newest placed in no plan
 * that no conversation owns, so whichever conversation reads the block, its
 * own newest are here, and every exact count, so the rest are counted rather
 * than sampled.
 */
export interface PendingAttention {
  /**
   * Newest first: up to `ATTENTION_ITEM_SURFACE_LIMIT` per plan root, as many
   * per live conversation of those placed in no plan, and as many of those no
   * conversation owns.
   */
  items: PendingAttentionItemSummary[];
  totals: PendingAttentionTotal[];
}

const EVERYONES = 'everyone';

/**
 * The pending items by the plan root their run serves, or the conversation
 * that owns a run serving none, or everyone, each one's newest kept and every
 * one counted.
 */
export function summarizePendingAttention(
  pending: PendingRunAttention,
  placements: ReadonlyMap<string, PlanPlacement>,
): PendingAttention | undefined {
  const placed = (nodeId: string | null) => {
    const plan = nodeId !== null ? placements.get(nodeId) : undefined;
    return plan !== undefined ? { plan } : {};
  };
  const driver = (sessionId: string | null) => (sessionId !== null ? { sessionId } : {});

  const totals: PendingAttentionTotal[] = pending.counts.map((count) => ({
    ...placed(count.planNodeId),
    ...driver(count.sessionId),
    drivenByLiveConversation: count.drivenByLiveConversation,
    total: count.count,
  }));
  if (totals.length === 0) return undefined;

  const kept = new Map<string, number>();
  const items: PendingAttentionItemSummary[] = [];
  for (const item of pending.items) {
    const summary: PendingAttentionItemSummary = {
      itemId: item.itemId,
      kind: item.kind,
      ...(item.runId !== null ? { runId: item.runId } : {}),
      ...(item.workflowSlug !== null ? { slug: item.workflowSlug } : {}),
      ...driver(item.sessionId),
      drivenByLiveConversation: item.drivenByLiveConversation,
      ...placed(item.planNodeId),
    };
    const group =
      summary.plan !== undefined
        ? `root:${summary.plan.rootId}`
        : summary.drivenByLiveConversation
          ? `session:${String(summary.sessionId)}`
          : EVERYONES;
    const count = kept.get(group) ?? 0;
    if (count >= ATTENTION_ITEM_SURFACE_LIMIT) continue;
    kept.set(group, count + 1);
    items.push(summary);
  }
  return { items, totals };
}

/**
 * The pending items as one conversation reads them: its own are those
 * `isReadersWork` gives it, and every other one is counted in `others`.
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
  const mine = (pending?.items ?? []).filter((item) => isReadersWork(item, reader));
  const own = mine.filter((item) => item.plan !== undefined).slice(0, ATTENTION_ITEM_SURFACE_LIMIT);
  const unplaced = mine
    .filter((item) => item.plan === undefined)
    .slice(0, ATTENTION_ITEM_SURFACE_LIMIT);
  let ownTotal = 0;
  let unplacedTotal = 0;
  let others = 0;
  for (const count of pending?.totals ?? []) {
    if (!isReadersWork(count, reader)) others += count.total;
    else if (count.plan !== undefined) ownTotal += count.total;
    else unplacedTotal += count.total;
  }
  return {
    own,
    ownUnshown: ownTotal - own.length,
    others,
    unplaced,
    unplacedUnshown: unplacedTotal - unplaced.length,
    placedAny: (pending?.totals ?? []).some((count) => count.plan !== undefined),
  };
}

/** The ids of the pending items a conversation's block shows it. */
export function renderedAttentionItemIds(items: ConversationAttentionItems): string[] {
  return [...items.own, ...items.unplaced].map((item) => item.itemId);
}
