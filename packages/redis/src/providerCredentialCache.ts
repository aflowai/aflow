import type { Redis } from 'ioredis';

export interface ProviderCredentialInvalidation {
  tenantId: string;
  /** When set, the change is scoped to a single provider. */
  providerId?: string;
  ts: number;
}

const CHANNEL_PREFIX = 'aflow:pubsub:provider-credentials';

function channelFor(tenantId: string): string {
  return `${CHANNEL_PREFIX}:${tenantId}`;
}

export function publishProviderCredentialInvalidation(
  redis: Redis,
  tenantId: string,
  payload: { providerId?: string } = {},
): void {
  const message: ProviderCredentialInvalidation = {
    tenantId,
    ts: Date.now(),
    ...(payload.providerId ? { providerId: payload.providerId } : {}),
  };
  redis.publish(channelFor(tenantId), JSON.stringify(message)).catch(() => {
    /* best-effort */
  });
}

export type ProviderCredentialInvalidationCallback = (msg: ProviderCredentialInvalidation) => void;

export async function subscribeProviderCredentialInvalidation(
  subscriberRedis: Redis,
  callback: ProviderCredentialInvalidationCallback,
): Promise<() => Promise<void>> {
  const pattern = `${CHANNEL_PREFIX}:*`;

  // Bind a named handler so the unsubscribe path can remove this specific
  // listener. Without this, repeated subscribe/unsubscribe cycles (hot
  // reload, test teardown, multiple subscribers on the same connection)
  // would leak listeners and duplicate invalidations on every replayed
  // message.
  const handler = (_pattern: string, _channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message) as Partial<ProviderCredentialInvalidation>;
      if (typeof parsed.tenantId !== 'string' || typeof parsed.ts !== 'number') return;
      callback(parsed as ProviderCredentialInvalidation);
    } catch {
      /* malformed — ignore */
    }
  };

  subscriberRedis.on('pmessage', handler);
  await subscriberRedis.psubscribe(pattern);

  return async () => {
    subscriberRedis.off('pmessage', handler);
    await subscriberRedis.punsubscribe(pattern);
  };
}
