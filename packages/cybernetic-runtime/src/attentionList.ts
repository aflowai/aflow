import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AttentionItemRow } from '@aflow/database';
import type {
  AttentionItemKind,
  WorkflowRunListAttentionInput,
  WorkflowRunListAttentionTruncation,
} from '@aflow/schemas';
import { isReadersWork, type AttentionReader } from './conversationOwnership.js';
import { listAttentionItems, type AttentionOwnerFilter } from './ledger/attention.js';
import {
  loadConversationPlanRoots,
  loadPlanSubtreeNodeIds,
  placeInPlan,
} from './plan/attention.js';
import { createPlanNodeStore, type PlanNodeStore } from './plan/store.js';

export interface ListedAttentionItem {
  item: AttentionItemRow;
  /** The item is the reading conversation's (`isReadersWork`). */
  own: boolean;
}

/**
 * The most of the space's attention rows one page examines. The query narrows
 * to the reader's own items, so a page fills in one read; only where the plan
 * under the reader's roots is too large to name does every placed item pass
 * it, and this bounds how many of other conversations' are read past before
 * the page is returned short.
 */
export const LIST_ATTENTION_SCAN_LIMIT = 500;

export interface ListedAttention {
  items: ListedAttentionItem[];
  hasMore: boolean;
  /** Present while `hasMore`: the next page lists the items after this one. */
  cursor?: string;
  /** The page is short because the read reached `LIST_ATTENTION_SCAN_LIMIT`. */
  truncated?: WorkflowRunListAttentionTruncation;
}

/**
 * A conversation's attention items, newest first and after `cursor` when
 * given, as `workflow.run.list_attention` lists them: by the same ownership
 * the attention block reads, its own only, unless `scope` is `'space'`,
 * which lists every conversation's with each one marked.
 */
export async function listAttentionForConversation(params: {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  sessionId: string;
  scope: WorkflowRunListAttentionInput['scope'];
  kind?: AttentionItemKind;
  includeConsumed: boolean;
  limit: number;
  cursor?: string;
}): Promise<ListedAttention> {
  const { db, tenantId, spaceId, sessionId, scope, limit } = params;
  const reader = {
    sessionId,
    planRootIds: new Set(await loadConversationPlanRoots({ db, tenantId, spaceId, sessionId })),
  };
  const store = createPlanNodeStore(db, tenantId);
  const owner = await ownerFilter(store, spaceId, scope, reader);
  // One past the page tells whether there is more.
  const page = limit + 1;
  const listed: ListedAttentionItem[] = [];
  let examined = 0;
  let afterItemId = params.cursor;
  for (;;) {
    const requested = Math.min(page, LIST_ATTENTION_SCAN_LIMIT - examined);
    const rows = await listAttentionItems(db, tenantId, {
      spaceId,
      ...(params.kind !== undefined ? { kind: params.kind } : {}),
      includeConsumed: params.includeConsumed,
      limit: requested,
      ...(afterItemId !== undefined ? { afterItemId } : {}),
      ...(owner !== undefined ? { owner } : {}),
    });
    examined += rows.length;
    const placements = await placeInPlan(
      store,
      spaceId,
      rows.map((row) => row.planNodeId),
    );
    for (const row of rows) {
      const plan = row.planNodeId !== null ? placements.get(row.planNodeId) : undefined;
      const own = isReadersWork(
        {
          ...(plan !== undefined ? { plan } : {}),
          ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
          drivenByLiveConversation: row.drivenByLiveConversation,
        },
        reader,
      );
      if (!own && scope !== 'space') continue;
      if (listed.length === limit) {
        return { items: listed, hasMore: true, ...cursorAfter(listed.at(-1)?.item) };
      }
      listed.push({ item: row.item, own });
    }
    const last = rows.at(-1);
    if (rows.length < requested || last === undefined) return { items: listed, hasMore: false };
    if (examined >= LIST_ATTENTION_SCAN_LIMIT) {
      return {
        items: listed,
        hasMore: true,
        cursor: last.item.id,
        truncated: { bound: 'rows_examined', value: LIST_ATTENTION_SCAN_LIMIT },
      };
    }
    afterItemId = last.item.id;
  }
}

function cursorAfter(item: AttentionItemRow | undefined): { cursor?: string } {
  return item !== undefined ? { cursor: item.id } : {};
}

/**
 * The query's narrowing to the reader's items under `scope: 'conversation'`:
 * its own unplaced runs by `session_id`, and its placed ones by every node
 * under the roots it has taken up.
 */
async function ownerFilter(
  store: PlanNodeStore,
  spaceId: string,
  scope: WorkflowRunListAttentionInput['scope'],
  reader: AttentionReader,
): Promise<AttentionOwnerFilter | undefined> {
  if (scope === 'space') return undefined;
  const planNodeIds = await loadPlanSubtreeNodeIds(store, spaceId, reader.planRootIds);
  return { sessionId: reader.sessionId, ...(planNodeIds !== undefined ? { planNodeIds } : {}) };
}
