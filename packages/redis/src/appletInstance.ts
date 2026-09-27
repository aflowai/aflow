import type { Redis } from 'ioredis';
import { AppletInstanceDeltaSchema, StreamKeys, type AppletInstanceDelta } from '@aflow/schemas';

/**
 * Fan out one committed applet action to every server instance holding a
 * subscriber. Fire-and-forget: a missed publish self-heals through the
 * client's version-gap refetch, so delivery is never allowed to fail the
 * write that produced it.
 */
export async function publishAppletInstanceDelta(
  redis: Redis,
  tenantId: string,
  delta: AppletInstanceDelta,
): Promise<void> {
  const channel = StreamKeys.appletInstanceChannel(tenantId, delta.instanceId);
  await redis.publish(channel, JSON.stringify(delta)).catch(() => {
    /* a missed publish costs a refetch, never a wrong state */
  });
}

/**
 * Watch one instance's committed deltas. The connection must be a dedicated
 * subscriber — once in subscribe mode it cannot issue commands. Off-spec
 * payloads are dropped rather than surfaced: the client's refetch path is the
 * recovery for anything missed.
 */
export function subscribeToAppletInstance(
  subscriberRedis: Redis,
  tenantId: string,
  instanceId: string,
  onDelta: (delta: AppletInstanceDelta) => void,
): () => Promise<void> {
  const channel = StreamKeys.appletInstanceChannel(tenantId, instanceId);
  const handler = (receivedChannel: string, message: string): void => {
    if (receivedChannel !== channel) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    const delta = AppletInstanceDeltaSchema.safeParse(parsed);
    if (delta.success) onDelta(delta.data);
  };
  void subscriberRedis.subscribe(channel).catch(() => {
    /* the topic handler reports subscription failure separately */
  });
  subscriberRedis.on('message', handler);
  return async () => {
    subscriberRedis.off('message', handler);
    await subscriberRedis.unsubscribe(channel).catch(() => {
      /* swallowed */
    });
  };
}
