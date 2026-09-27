import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import {
  ENTITY_EVENTS_PUBSUB_CHANNEL,
  readEntityEventStreamEntries,
  createSubscriberConnection,
  getRedisConfig,
} from '@aflow/redis';
import type { TopicHandler, TopicSubscribeContext, TopicSubscribeResult } from '../realtime.js';
import { canReadSpace } from './authz.js';

export interface SpaceEntityEventsTopicDeps {
  redis: Redis | null;
  db: PostgresJsDatabase | null;
}

const DRAIN_BATCH_MAX = 500;

export function createSpaceEntityEventsTopicHandler(
  deps: SpaceEntityEventsTopicDeps,
): TopicHandler {
  return {
    kind: 'space.entity_events',
    async subscribe(ctx: TopicSubscribeContext): Promise<TopicSubscribeResult> {
      if (ctx.topic.kind !== 'space.entity_events') {
        return { kind: 'not_supported' };
      }
      const redis = deps.redis;
      if (!redis) {
        return {
          kind: 'denied',
          code: 'service_unavailable',
          message: 'Redis is not configured on this server',
        };
      }
      const { spaceId } = ctx.topic;
      const tenantId = ctx.connection.tenantId;

      if (deps.db) {
        const allowed = await canReadSpace(
          deps.db,
          tenantId,
          ctx.connection.userId,
          spaceId,
          ctx.connection.token.authMethod,
        );
        if (!allowed) {
          return {
            kind: 'denied',
            code: 'subscribe_denied',
            message: 'No read access to this space',
          };
        }
      }

      let cursor = ctx.topic.cursor && ctx.topic.cursor.length > 0 ? ctx.topic.cursor : '0';
      let cancelled = false;
      let draining = false;
      let drainRequested = false;

      /**
       * Read forward from the cursor until the stream is exhausted.
       *
       * A wake that lands mid-drain is re-armed rather than dropped: the read
       * it would have triggered may already have been issued, so discarding it
       * loses the event until some unrelated write wakes the tail again.
       */
      const drain = async () => {
        if (cancelled) return;
        if (draining) {
          drainRequested = true;
          return;
        }
        draining = true;
        try {
          do {
            drainRequested = false;
            let more = true;
            while (more && !cancelled) {
              const { entries, lastCursor, hasMore } = await readEntityEventStreamEntries(redis, {
                tenantId,
                spaceId,
                fromId: cursor,
                count: DRAIN_BATCH_MAX,
              });
              for (const { streamId, event } of entries) {
                if (cancelled) return;
                ctx.emit({
                  type: 'event',
                  subscriptionId: ctx.subscriptionId,
                  topicKey: ctx.topicKey,
                  cursor: streamId,
                  event,
                });
                cursor = streamId;
              }
              // Past `lastCursor` even where nothing was emitted — a page of
              // unparseable rows would otherwise re-read itself forever.
              cursor = lastCursor;
              more = hasMore;
            }
          } while (drainRequested && !cancelled);
        } finally {
          draining = false;
        }
      };

      const drainSafely = (reason: string) => {
        void drain().catch((err: unknown) => {
          console.warn(`[space.entity_events] drain failed (${reason})`, err);
        });
      };

      const subscriber = createSubscriberConnection(getRedisConfig());
      const channel = ENTITY_EVENTS_PUBSUB_CHANNEL(tenantId, spaceId);
      let subscribed = false;

      const start = async () => {
        subscriber.on('message', () => {
          if (!cancelled) drainSafely('wake');
        });

        try {
          await subscriber.subscribe(channel);
          subscribed = true;
        } catch (err) {
          console.warn('[space.entity_events] pub/sub subscribe failed', err);
        }

        // Registered past the first connect, so every `ready` from here is a
        // reconnect. Pub/Sub has no replay: the outage leaves a hole in the
        // channel that only a read from the cursor can close.
        subscriber.on('ready', () => {
          if (cancelled) return;
          if (!subscribed) {
            void subscriber
              .subscribe(channel)
              .then(() => {
                subscribed = true;
              })
              .catch(() => undefined);
          }
          drainSafely('reconnect');
        });

        // Only after the subscription is acknowledged: anything written before
        // this read is in the stream, anything after it arrives as a wake.
        try {
          await drain();
        } catch (err) {
          console.warn('[space.entity_events] initial drain failed', err);
        }
      };

      return {
        kind: 'accepted',
        cursor,
        start,
        cleanup: async () => {
          cancelled = true;
          try {
            await subscriber.unsubscribe(channel);
          } catch {
            /* idempotent */
          }
          try {
            await subscriber.quit();
          } catch {
            /* idempotent */
          }
        },
      };
    },
  };
}
