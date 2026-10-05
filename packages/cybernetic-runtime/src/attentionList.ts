import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AttentionItemRow } from '@aflow/database';
import type { AttentionItemKind, WorkflowRunListAttentionInput } from '@aflow/schemas';
import { isReadersWork } from './conversationOwnership.js';
import { listAttentionItems } from './ledger/attention.js';
import { loadConversationPlanRoots, placeInPlan } from './plan/attention.js';
import { createPlanNodeStore } from './plan/store.js';

export interface ListedAttentionItem {
  item: AttentionItemRow;
  /** The item is the reading conversation's (`isReadersWork`). */
  own: boolean;
}

/**
 * A conversation's attention items, newest first, as
 * `workflow.run.list_attention` lists them: by the same ownership the
 * attention block reads, its own only, unless `scope` is `'space'`, which
 * lists every conversation's with each one marked.
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
}): Promise<{ items: ListedAttentionItem[]; hasMore: boolean }> {
  const { db, tenantId, spaceId, sessionId, scope, limit } = params;
  const reader = {
    sessionId,
    planRootIds: new Set(await loadConversationPlanRoots({ db, tenantId, spaceId, sessionId })),
  };
  const store = createPlanNodeStore(db, tenantId);
  // One past the page tells whether there is more.
  const page = limit + 1;
  const listed: ListedAttentionItem[] = [];
  let afterItemId: string | undefined;
  for (;;) {
    const rows = await listAttentionItems(db, tenantId, {
      spaceId,
      ...(params.kind !== undefined ? { kind: params.kind } : {}),
      includeConsumed: params.includeConsumed,
      limit: page,
      ...(afterItemId !== undefined ? { afterItemId } : {}),
    });
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
      listed.push({ item: row.item, own });
      if (listed.length === page) return { items: listed.slice(0, limit), hasMore: true };
    }
    const last = rows.at(-1);
    if (rows.length < page || last === undefined) return { items: listed, hasMore: false };
    afterItemId = last.item.id;
  }
}
