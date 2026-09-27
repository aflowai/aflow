import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

export interface ActionCenterFocusMessage {
  /** Action Center item id (e.g., `proposal:<uuid>`, `step:<uuid>`, `gate:<uuid>`). */
  itemId: string;
  /** Optional rationale shown to the operator. Kept short (<=280 chars). */
  reason?: string;
  /** Publish timestamp (ms since epoch). Used for debounce/dedupe on the client. */
  ts: number;
  /** Tenant + space the message belongs to (echoed for sanity checks). */
  tenantId: string;
  spaceId: string;
}

/**
 * Publish a focus signal on the per-space pubsub channel. Fire-and-forget;
 * the action-center SSE route forwards subscribed messages to clients.
 */
export function publishActionCenterFocus(
  redis: Redis,
  msg: Omit<ActionCenterFocusMessage, 'ts'>,
): void {
  const channel = StreamKeys.actionCenterFocusChannel(msg.tenantId, msg.spaceId);
  const message: ActionCenterFocusMessage = { ...msg, ts: Date.now() };
  // Returns the number of clients that received the message. Useful for
  // diagnosing the "nothing rendered" case — 0 subscribers means the
  // client SSE either isn't connected or didn't subscribe in time.
  redis
    .publish(channel, JSON.stringify(message))
    .then((receivers) => {
      console.info(
        `[action-center-focus] publish channel=${channel} receivers=${String(receivers)} itemId=${msg.itemId}`,
      );
    })
    .catch((err: unknown) => {
      console.warn(`[action-center-focus] publish failed channel=${channel}`, err);
    });
}

export interface ActionCenterWakeMessage {
  /** Which producer domain changed action-center-visible state (log label). */
  source: string;
  /** Publish timestamp (ms since epoch). */
  ts: number;
  tenantId: string;
  /** Absent for items that surface in every space of the tenant. */
  spaceId?: string;
}

/**
 * Wake the action-center topic after a producer changes what an action center
 * shows — one space's when `spaceId` is given, every space's of the tenant
 * when it is not. Fire-and-forget: the publish rides after the producing
 * write commits and never blocks or fails it. A lost wake is repaired by the
 * topic's residual audit.
 */
export function publishActionCenterWake(
  redis: Redis,
  msg: Omit<ActionCenterWakeMessage, 'ts'>,
): void {
  const channel =
    msg.spaceId !== undefined
      ? StreamKeys.actionCenterWakeChannel(msg.tenantId, msg.spaceId)
      : StreamKeys.actionCenterTenantWakeChannel(msg.tenantId);
  const message: ActionCenterWakeMessage = { ...msg, ts: Date.now() };
  redis.publish(channel, JSON.stringify(message)).catch((err: unknown) => {
    console.warn(`[action-center-wake] publish failed channel=${channel}`, err);
  });
}
