import { randomUUID } from 'node:crypto';
import { appendEntityEvent } from '@aflow/redis';

type RedisClient = Parameters<typeof appendEntityEvent>[0];

/**
 * Best-effort space-level "a run changed" signal (`entity.run.updated`) so
 * surfaces like the Workbench run feed refresh on real transitions instead of
 * polling. Emitted on every run-status transition — create, pause, resume,
 * terminal — from whichever plane commits it (harness or operator resume).
 * Deliberately not narrated (no console map entry). Never throws.
 */
export async function emitRunUpdated(
  redis: RedisClient | null | undefined,
  params: {
    tenantId: string;
    spaceId: string;
    runId: string;
    workflowSlug: string;
    status: string;
  },
): Promise<void> {
  if (!redis) return;
  try {
    await appendEntityEvent(redis, {
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      event: {
        eventId: randomUUID(),
        eventType: 'entity.run.updated',
        spaceId: params.spaceId,
        tenantId: params.tenantId,
        timestamp: Date.now(),
        workflowSlug: params.workflowSlug,
        workflowRunId: params.runId,
        payload: { runId: params.runId, status: params.status },
        summary: `Workflow run ${params.status}`,
      },
    });
  } catch {
    // Best-effort — a missed signal just means the feed refreshes on the next
    // transition; never let it affect run lifecycle.
  }
}
