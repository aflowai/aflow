import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

/** Best-effort pub/sub so GuardrailGate reloads compiled policies. */
export async function publishGuardrailCacheInvalidation(
  redis: Redis,
  tenantId: string,
): Promise<void> {
  const channel = StreamKeys.guardrailInvalidateChannel(tenantId);
  await redis
    .publish(channel, JSON.stringify({ tenantId, invalidatedAt: Date.now() }))
    .catch(() => {
      // Best-effort pub/sub
    });
}
