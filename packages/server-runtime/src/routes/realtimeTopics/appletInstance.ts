import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import {
  subscribeToAppletInstance,
  createSubscriberConnection,
  getRedisConfig,
} from '@aflow/redis';
import type { TenantId } from '@aflow/schemas';
import type { TopicHandler, TopicSubscribeContext, TopicSubscribeResult } from '../realtime.js';
import { canReadSpace } from './authz.js';
import { resolveAppletInstanceSpaceId } from '../../lib/appletInstanceLookup.js';

export interface AppletInstanceTopicDeps {
  db: PostgresJsDatabase;
  redis: Redis | null;
}

/**
 * Live deltas for one applet instance, authorized by the instance's space
 * membership. Delivery is fire-and-forget off the pub/sub channel the action
 * route publishes to — no server-side replay; a version gap on the client
 * triggers a refetch of current state.
 */
export function createAppletInstanceTopicHandler(deps: AppletInstanceTopicDeps): TopicHandler {
  return {
    kind: 'applet.instance',
    async subscribe(ctx: TopicSubscribeContext): Promise<TopicSubscribeResult> {
      if (ctx.topic.kind !== 'applet.instance') return { kind: 'not_supported' };
      const { redis } = deps;
      if (!redis) {
        return {
          kind: 'denied',
          code: 'service_unavailable',
          message: 'Applet delivery requires Redis',
        };
      }

      const tenantId = ctx.connection.tenantId;
      const { instanceId } = ctx.topic;

      const spaceId = await resolveAppletInstanceSpaceId(deps.db, tenantId as TenantId, instanceId);
      // One denial for both "no such instance" and "no access" — whether an
      // instance exists is itself a fact about the space it lives in.
      const allowed =
        spaceId !== null &&
        (await canReadSpace(
          deps.db,
          tenantId,
          ctx.connection.userId,
          spaceId,
          ctx.connection.token.authMethod,
        ));
      if (!allowed) {
        return {
          kind: 'denied',
          code: 'subscribe_denied',
          message: 'No read access to this applet instance',
        };
      }

      // A dedicated connection: once in subscribe mode it cannot issue commands.
      const subscriber = createSubscriberConnection(getRedisConfig());
      let unsubscribe: (() => Promise<void>) | null = null;

      return {
        kind: 'accepted',
        start: () => {
          unsubscribe = subscribeToAppletInstance(subscriber, tenantId, instanceId, (delta) => {
            ctx.emit({
              type: 'event',
              subscriptionId: ctx.subscriptionId,
              topicKey: ctx.topicKey,
              cursor: String(delta.stateVersion),
              event: delta,
            });
          });
        },
        cleanup: async () => {
          if (unsubscribe) await unsubscribe();
          await subscriber.quit().catch(() => {
            /* connection already gone */
          });
        },
      };
    },
  };
}
