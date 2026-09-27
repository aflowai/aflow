import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import {
  markAway,
  markPresent,
  readPresence,
  subscribeToPresence,
  createSubscriberConnection,
  getRedisConfig,
} from '@aflow/redis';
import type { PresenceActivity, SessionId, TenantId } from '@aflow/schemas';
import type { TopicHandler, TopicSubscribeContext, TopicSubscribeResult } from '../realtime.js';
import { canReadSession } from './authz.js';

export interface SessionPresenceTopicDeps {
  db: PostgresJsDatabase;
  redis: Redis | null;
}

/**
 * Names are deliberately absent: the roster says who is present, and the
 * client already knows the space's members. A second copy of a person's name
 * in ephemeral state is a copy that can go stale.
 */
interface LiveSubscription {
  tenantId: string;
  sessionId: string;
  userId: string;
  tabId: string;
  activity: PresenceActivity;
}

/** Keyed by subscription so a `presence_update` can find its room. */
const liveSubscriptions = new Map<string, LiveSubscription>();

export async function applyPresenceUpdate(
  redis: Redis | null,
  subscriptionId: string,
  activity: PresenceActivity,
): Promise<void> {
  const sub = liveSubscriptions.get(subscriptionId);
  if (!sub || !redis) return;
  sub.activity = activity;
  await markPresent(redis, sub.tenantId, sub.sessionId, {
    userId: sub.userId,
    tabId: sub.tabId,
    activity,
  });
}

export function createSessionPresenceTopicHandler(deps: SessionPresenceTopicDeps): TopicHandler {
  return {
    kind: 'session.presence',
    async subscribe(ctx: TopicSubscribeContext): Promise<TopicSubscribeResult> {
      if (ctx.topic.kind !== 'session.presence') return { kind: 'not_supported' };
      const { redis } = deps;
      if (!redis) {
        return { kind: 'denied', code: 'service_unavailable', message: 'Presence requires Redis' };
      }

      const tenantId = ctx.connection.tenantId as TenantId;
      const sessionId = ctx.topic.sessionId as SessionId;
      const userId = ctx.connection.userId;

      // Presence reveals who is looking at a room, so it is gated exactly
      // like reading the room itself.
      const allowed = await canReadSession(
        deps.db,
        redis,
        tenantId,
        userId,
        sessionId,
        ctx.connection.token.authMethod,
      );
      if (!allowed) {
        return {
          kind: 'denied',
          code: 'subscribe_denied',
          message: 'No read access to this session',
        };
      }

      const tabId = ctx.connection.tabId;
      liveSubscriptions.set(ctx.subscriptionId, {
        tenantId,
        sessionId,
        userId,
        tabId,
        activity: 'viewing',
      });

      // A dedicated connection: once in subscribe mode it cannot issue
      // commands, and the roster read below is a command.
      const subscriberRedis = createSubscriberConnection(getRedisConfig());
      let unsubscribe: (() => Promise<void>) | null = null;
      let closed = false;

      const emitRoster = async (): Promise<void> => {
        if (closed) return;
        try {
          const participants = await readPresence(redis, tenantId, sessionId);
          ctx.emit({
            type: 'snapshot',
            subscriptionId: ctx.subscriptionId,
            topicKey: ctx.topicKey,
            // A roster has no history to resume from — the current answer is
            // the only answer — so the cursor is just the moment it was read.
            cursor: String(Date.now()),
            data: { sessionId, participants },
          });
        } catch (err) {
          console.warn('[session.presence] roster read failed', err);
        }
      };

      return {
        kind: 'accepted',
        start: async () => {
          unsubscribe = subscribeToPresence(subscriberRedis, tenantId, sessionId, () => {
            void emitRoster();
          });
          // Announce arrival first so the roster this subscriber receives
          // already contains them — otherwise the newcomer sees a room
          // without themselves in it until their first heartbeat.
          await markPresent(redis, tenantId, sessionId, {
            userId,
            tabId,
            activity: 'viewing',
          });
          await emitRoster();
        },
        cleanup: async () => {
          closed = true;
          liveSubscriptions.delete(ctx.subscriptionId);
          if (unsubscribe) await unsubscribe();
          await markAway(redis, tenantId, sessionId, { userId, tabId }).catch(() => {
            /* the entry ages out on its own */
          });
          await subscriberRedis.quit().catch(() => {
            /* connection already gone */
          });
        },
      };
    },
  };
}
