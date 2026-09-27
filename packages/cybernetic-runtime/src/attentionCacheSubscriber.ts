import type { Redis } from 'ioredis';
import { bumpAttentionGeneration } from './attentionCache.js';
import { cyberneticHookSafe, type HookSafeContext } from './hookSafe.js';
import { getCyberneticLogger } from './logger.js';

// ============================================================================
// §4.2 Invalidation event types
// ============================================================================

/**
 * Entity event types that invalidate the Helmsman attention cache.
 * From §4.2 of 104c plan.
 */
const INVALIDATION_EVENT_TYPES = new Set([
  'entity.procedure.activated',
  'entity.procedure.completed',
  'entity.coach.activated',
  'entity.coach.completed',
  'entity.coach.proposal',
  'entity.coach.ratified',
  'entity.coach.rejected',
  'entity.coach.withdrawn',
  'entity.coach.anomaly',
  'entity.coach.platform_issue_acknowledged',
  'entity.coach.anomaly_acknowledged',
  'entity.coach.ratification_failed',
  'entity.eval.completed',
  'entity.eval.regression',
  'entity.memory.mutation',
]);

/**
 * For `entity.memory.mutation`, only invalidate if the path prefix is
 * in the attention-relevant set.
 */
const ATTENTION_RELEVANT_PATH_PREFIXES = ['/identity', '/learnings', '/skills'];

// ============================================================================
// Pub/Sub channel pattern
// ============================================================================

/**
 * The entity events pub/sub channel pattern.
 * Matches: `entity_events:pubsub:{tenantId}:{spaceId}`
 *
 * This mirrors ENTITY_EVENTS_PUBSUB_CHANNEL from @aflow/redis
 * without importing it directly (to avoid circular deps).
 */
const ENTITY_EVENTS_PUBSUB_PATTERN = 'entity_events:pubsub:*:*';

// ============================================================================
// Subscriber
// ============================================================================

interface PubSubMessage {
  type?: string;
  eventType?: string;
  spaceId?: string;
  pathPrefix?: string;
}

/**
 * Start the attention cache invalidation subscriber.
 *
 * Uses PSUBSCRIBE to pattern-match all entity event pub/sub channels,
 * then bumps the generation when a matching event arrives.
 *
 * @param subscriberRedis - A dedicated Redis connection for subscriptions
 *   (ioredis requires separate connections for pub/sub).
 * @param cacheRedis - The Redis connection used for cache operations.
 * @returns A cleanup function to unsubscribe.
 */
export async function startAttentionCacheSubscriber(
  subscriberRedis: Redis,
  cacheRedis: Redis,
): Promise<() => Promise<void>> {
  const logger = getCyberneticLogger();

  await subscriberRedis.psubscribe(ENTITY_EVENTS_PUBSUB_PATTERN);

  const handler = (pattern: string, channel: string, message: string) => {
    // Parse tenantId and spaceId from channel: entity_events:pubsub:{tenantId}:{spaceId}
    const parts = channel.split(':');
    if (parts.length < 4) return;
    const tenantId = parts[2]!;
    const spaceId = parts[3]!;

    let parsed: PubSubMessage;
    try {
      parsed = JSON.parse(message) as PubSubMessage;
    } catch {
      return;
    }

    const eventType = parsed.eventType;
    if (!eventType) return;

    // Check if this event type triggers invalidation
    if (!INVALIDATION_EVENT_TYPES.has(eventType)) return;

    // For memory mutations, only invalidate for attention-relevant paths
    if (eventType === 'entity.memory.mutation') {
      const pathPrefix = parsed.pathPrefix;
      if (!pathPrefix || !ATTENTION_RELEVANT_PATH_PREFIXES.some((p) => pathPrefix.startsWith(p))) {
        return;
      }
    }

    // Bump generation — wrapped in hookSafe for observability
    const ctx: HookSafeContext = { redis: cacheRedis, tenantId, spaceId };
    cyberneticHookSafe(
      'attention-cache-invalidator',
      () => bumpAttentionGeneration(cacheRedis, tenantId, spaceId),
      ctx,
    ).catch(() => {
      // hookSafe handles failure observability
    });

    logger.debug(`attentionCacheSubscriber: invalidated ${tenantId}:${spaceId} on ${eventType}`);
  };

  subscriberRedis.on('pmessage', handler);

  logger.info('attentionCacheSubscriber: started');

  return async () => {
    subscriberRedis.off('pmessage', handler);
    await subscriberRedis.punsubscribe(ENTITY_EVENTS_PUBSUB_PATTERN);
    logger.info('attentionCacheSubscriber: stopped');
  };
}
