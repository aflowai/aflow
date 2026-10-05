import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import {
  buildHelmsmanAttention,
  renderAttentionContext,
  type AttentionConversation,
} from './attentionBuilder.js';
import { markAttentionConsumed } from './ledger.js';
import { getCyberneticLogger } from './logger.js';
import { pendingAttentionFor } from './pendingAttention.js';

/**
 * The attention block one Helmsman turn reads. An attention item is a
 * wake-up, read once: every item the block shows this conversation is
 * consumed by its session as the block is built, so the next turn's block no
 * longer carries it and `workflow.run.list_attention` lists it as consumed.
 */
export async function readAttentionForTurn(params: {
  tenantId: string;
  spaceId: string;
  sessionId: string;
  conversation: AttentionConversation;
  db: PostgresJsDatabase;
  redis: Redis;
}): Promise<string> {
  const { tenantId, spaceId, sessionId, conversation, db, redis } = params;
  const attention = await buildHelmsmanAttention({ tenantId, spaceId, db, redis });
  const text = renderAttentionContext(attention, conversation);
  const items = pendingAttentionFor(attention.pendingAttention, new Set(conversation.planRootIds));
  const shown = [...items.own, ...items.unplaced].map((item) => item.itemId);
  try {
    await markAttentionConsumed(db, redis, tenantId, { ids: shown, consumedBySession: sessionId });
  } catch (err) {
    getCyberneticLogger().warn(
      'readAttentionForTurn: the attention items this turn reads could not be marked consumed; the next turn shows them again',
      { error: err instanceof Error ? err.message : String(err), tenantId, spaceId, sessionId },
    );
  }
  return text;
}
