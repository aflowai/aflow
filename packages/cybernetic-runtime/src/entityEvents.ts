import { randomUUID } from 'node:crypto';
import { appendEntityEvent } from '@aflow/redis';
import type { PullRequestChange } from '@aflow/schemas';

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
    /** The node's status after the write, where the write holds the node. */
    status?: string;
    /** The node's status before the write, where the write read it. */
    previousStatus?: string;
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
        payload: {
          nodeId: params.nodeId,
          revision: params.revision,
          ...(params.status !== undefined ? { status: params.status } : {}),
          ...(params.previousStatus !== undefined ? { previousStatus: params.previousStatus } : {}),
        },
        summary:
          params.status !== undefined &&
          params.previousStatus !== undefined &&
          params.status !== params.previousStatus
            ? `Plan node moved from ${params.previousStatus} to ${params.status}`
            : `Plan node written at revision ${String(params.revision)}`,
      },
    });
  } catch {
    // Best-effort — a missed signal leaves the page as it stood until the
    // next write or run change; never let it affect the write.
  }
}

/**
 * A wait kind of its own on the space's entity events (Plan 339 D1). The
 * append records it for its waiters in the same transaction. Best-effort like
 * the other signals: a waiter whose event is lost is still woken when its
 * window closes. Never throws.
 */
async function emitWaitKind(
  redis: RedisClient | null | undefined,
  params: {
    tenantId: string;
    spaceId: string;
    eventType: 'entity.pull_request.changed' | 'entity.gate.resolved' | 'entity.folder.head_moved';
    subject: string;
    payload: Record<string, unknown>;
    summary: string;
  },
): Promise<boolean> {
  if (!redis) return false;
  try {
    await appendEntityEvent(redis, {
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      event: {
        eventId: randomUUID(),
        eventType: params.eventType,
        spaceId: params.spaceId,
        tenantId: params.tenantId,
        timestamp: Date.now(),
        payload: { ...params.payload, subject: params.subject },
        summary: params.summary.slice(0, 500),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** A loop pull request changed: its checks went green, it merged, it conflicts, or a review asked for changes. */
export async function emitPullRequestChanged(
  redis: RedisClient | null | undefined,
  params: {
    tenantId: string;
    spaceId: string;
    /** `owner/repo#number`. */
    subject: string;
    change: PullRequestChange;
    url: string;
    headSha: string;
  },
): Promise<boolean> {
  return emitWaitKind(redis, {
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    eventType: 'entity.pull_request.changed',
    subject: params.subject,
    payload: { change: params.change, url: params.url, headSha: params.headSha },
    summary: `Pull request ${params.subject}: ${params.change.replace(/_/g, ' ')}`,
  });
}

/** An Action Center item was resolved. */
export async function emitGateResolved(
  redis: RedisClient | null | undefined,
  params: { tenantId: string; spaceId: string; itemId: string; resolution: string },
): Promise<boolean> {
  return emitWaitKind(redis, {
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    eventType: 'entity.gate.resolved',
    subject: params.itemId,
    payload: { resolution: params.resolution },
    summary: `Action Center item resolved: ${params.resolution}`,
  });
}

/** A connected folder's head moved. */
export async function emitFolderHeadMoved(
  redis: RedisClient | null | undefined,
  params: { tenantId: string; spaceId: string; bindingId: string; head: string },
): Promise<boolean> {
  return emitWaitKind(redis, {
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    eventType: 'entity.folder.head_moved',
    subject: params.bindingId,
    payload: { head: params.head },
    summary: `Folder head moved to ${params.head}`,
  });
}
