import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import {
  buildHelmsmanAttention,
  renderAttentionContext,
  type AttentionConversation,
} from './attentionBuilder.js';
import { markAttentionConsumed } from './ledger.js';
import { getCyberneticLogger } from './logger.js';
import { pendingAttentionFor, renderedAttentionItemIds } from './pendingAttention.js';

/** The attention block one Helmsman turn reads, and the ids of the attention items it shows. */
export interface TurnAttention {
  text: string;
  itemIds: string[];
}

/**
 * The attention block one Helmsman turn reads. An attention item is a
 * wake-up, read once — by a turn the model has answered: building the block
 * consumes nothing, and the turn that succeeds consumes what it was shown
 * (`consumeAttentionReadByTurn`). A turn that fails or is retried shows the
 * same items again.
 */
export async function readAttentionForTurn(params: {
  tenantId: string;
  spaceId: string;
  conversation: AttentionConversation;
  db: PostgresJsDatabase;
  redis: Redis;
}): Promise<TurnAttention> {
  const { tenantId, spaceId, conversation, db, redis } = params;
  const attention = await buildHelmsmanAttention({ tenantId, spaceId, db, redis });
  const items = pendingAttentionFor(attention.pendingAttention, {
    sessionId: conversation.sessionId,
    planRootIds: new Set(conversation.planRootIds),
  });
  return {
    text: renderAttentionContext(attention, conversation),
    itemIds: renderedAttentionItemIds(items),
  };
}

/**
 * Consume, by the session whose turn read them, the attention items a
 * succeeded turn was shown, so the next turn's block no longer carries them
 * and `workflow.run.list_attention` lists them as consumed. A failure leaves
 * them pending, and the next turn shows them again.
 */
export async function consumeAttentionReadByTurn(params: {
  tenantId: string;
  sessionId: string;
  itemIds: readonly string[];
  db: PostgresJsDatabase;
  redis: Redis;
}): Promise<void> {
  const { tenantId, sessionId, itemIds, db, redis } = params;
  try {
    await markAttentionConsumed(db, redis, tenantId, {
      ids: itemIds,
      consumedBySession: sessionId,
    });
  } catch (err) {
    getCyberneticLogger().warn(
      'consumeAttentionReadByTurn: the attention items this turn read could not be marked consumed; the next turn shows them again',
      { error: err instanceof Error ? err.message : String(err), tenantId, sessionId },
    );
  }
}
