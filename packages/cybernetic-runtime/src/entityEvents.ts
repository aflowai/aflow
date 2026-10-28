import { randomUUID } from 'node:crypto';
import { appendEntityEvent } from '@aflow/redis';

type RedisClient = Parameters<typeof appendEntityEvent>[0];

/**
 * Best-effort space-level "the plan changed" signal (`entity.plan.updated`,
 * Plan 332 D9) so the plan page refreshes on a write instead of a reload.
 * Emitted after a plan-node write commits; a refused write emits nothing.
 * Never throws.
 *
 * Unlike `emitRunUpdated` it does not bump the attention generation: every
 * plan write path already does, and a second bump would wake twice.
 */
export async function emitPlanUpdated(
  redis: RedisClient | null | undefined,
  params: {
    tenantId: string;
    spaceId: string;
    nodeId: string;
    revision: number;
  },
): Promise<void> {
  if (!redis) return;
  try {
    await appendEntityEvent(redis, {
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.plan.updated',
        spaceId: params.spaceId,
        tenantId: params.tenantId,
        timestamp: Date.now(),
        payload: { nodeId: params.nodeId, revision: params.revision },
        summary: `Plan node written at revision ${String(params.revision)}`,
      },
    });
  } catch {
    // Best-effort — a missed signal leaves the page as it stood until the
    // next write or run change; never let it affect the write.
  }
}
