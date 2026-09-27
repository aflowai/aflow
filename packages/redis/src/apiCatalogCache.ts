import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

export interface ApiCatalogInvalidation {
  kind: 'definition' | 'binding' | 'credential' | 'simulation';
  tenantId: string;
  spaceId: string;
  apiId?: string;
  ts: number;
}

/**
 * Publish a cache invalidation signal after a definition, binding, credential
 * or simulation mutation. Fire-and-forget — failures are silently swallowed.
 */
export function publishApiCatalogInvalidation(
  redis: Redis,
  tenantId: string,
  spaceId: string,
  payload: { kind: ApiCatalogInvalidation['kind']; apiId?: string },
): void {
  const channel = StreamKeys.apiCatalogInvalidateChannel(tenantId);
  const message: ApiCatalogInvalidation = {
    kind: payload.kind,
    tenantId,
    spaceId,
    ts: Date.now(),
    ...(payload.apiId ? { apiId: payload.apiId } : {}),
  };
  redis.publish(channel, JSON.stringify(message)).catch(() => {
    // Best-effort — TTL cache is the fallback.
  });
}

export type ApiCatalogInvalidationCallback = (msg: ApiCatalogInvalidation) => void;

/**
 * Subscribe to API catalog invalidation signals for all tenants.
 * Uses pattern subscribe (`aflow:pubsub:api-catalog:*`).
 *
 * IMPORTANT: the `subscriberRedis` connection must be dedicated to Pub/Sub —
 * once a connection enters subscriber mode it cannot issue regular commands.
 *
 * Returns an unsubscribe function for cleanup.
 */
export async function subscribeApiCatalogInvalidation(
  subscriberRedis: Redis,
  callback: ApiCatalogInvalidationCallback,
): Promise<() => Promise<void>> {
  const pattern = 'aflow:pubsub:api-catalog:*';

  // Named handler so the unsubscribe path can remove THIS specific listener
  // (no leak across repeated subscribe/unsubscribe — hot reload, tests).
  const handler = (_pattern: string, _channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message) as Partial<ApiCatalogInvalidation>;
      if (typeof parsed.tenantId !== 'string' || typeof parsed.spaceId !== 'string') return;
      if (parsed.spaceId.length === 0) return;
      callback(parsed as ApiCatalogInvalidation);
    } catch {
      // Malformed message — ignore.
    }
  };

  subscriberRedis.on('pmessage', handler);
  await subscriberRedis.psubscribe(pattern);

  return async () => {
    subscriberRedis.off('pmessage', handler);
    await subscriberRedis.punsubscribe(pattern);
  };
}
