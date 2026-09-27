import type { Redis } from 'ioredis';
import { StreamKeys, type RoomMessageMetadata } from '@aflow/schemas';
import { appendSessionEvent } from './events.js';
import { markProjectionCandidate } from './projectionCandidates.js';
import { sessionCandidateMember } from './candidateMember.js';
import { syncSessionMetadataCandidate } from './sessionMetadataCandidates.js';
import { HOT_STATE_TTL_SECONDS } from './schemas.js';

export interface AppendRoomMessageInput {
  actorUserId: string;
  actorDisplayName?: string;
  body: string;
  clientMessageId?: string;
  /** Whether this message also asks the agent to act on the room. */
  wakeHelmsman?: boolean;
  /**
   * Caller-supplied event id for deliveries that must be idempotent — the
   * durable event write dedups on it, so a retried post collapses to one row.
   * Defaults to a fresh uuid.
   */
  eventId?: string;
}

export type AppendRoomMessageResult =
  | { ok: true; messageSeq: number; eventId: string }
  | { ok: false; reason: 'session_not_hot' | 'duplicate_event' };

/**
 * Post a message into a session's room without advancing the agent.
 *
 * Positions come from HINCRBY on the session's own hash, so two people posting
 * at once get distinct positions without a lock. The field is created by the
 * increment, which is why the session's presence is checked first — otherwise
 * a message for an expired or unknown session would materialise a hash with
 * nothing but a counter in it and resurrect a dead session.
 */
/**
 * Take the next position in a room's conversation.
 *
 * Positions come from HINCRBY on the session's own hash, so two people writing
 * at once get distinct positions without a lock. Every human message in a room
 * takes one — the ones that start or resume the session as much as the ones
 * posted into it — because a position that skipped some of them could not
 * answer "how many messages have I not read".
 */
export async function allocateMessageSeq(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<number> {
  const stateKey = StreamKeys.sessionStateKey(tenantId, sessionId);
  const messageSeq = await redis.hincrby(stateKey, 'lastMessageSeq', 1);
  // The increment creates the field, so an expiry landing just before it would
  // leave a hash holding nothing but a counter and no expiry of its own.
  // Re-arming bounds that, and keeps a room people are actively talking in
  // from ageing out underneath them.
  await redis.expire(stateKey, HOT_STATE_TTL_SECONDS);
  return messageSeq;
}

export async function appendRoomMessage(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  input: AppendRoomMessageInput,
): Promise<AppendRoomMessageResult> {
  const stateKey = StreamKeys.sessionStateKey(tenantId, sessionId);
  if ((await redis.exists(stateKey)) !== 1) {
    return { ok: false, reason: 'session_not_hot' };
  }

  // A caller-supplied eventId is a promise of idempotence the stream cannot
  // keep by itself: XADD has no dedup and the durable-log check upstream is
  // check-then-act, so two racing relay drains (or a crash inside the post)
  // would double-append and double-increment lastMessageSeq — phantom unread
  // for everyone else in the room. NX on the eventId closes both windows.
  if (input.eventId) {
    const guardKey = `${stateKey}:msg:${input.eventId}`;
    const claimed = await redis.set(guardKey, '1', 'EX', HOT_STATE_TTL_SECONDS, 'NX');
    if (claimed === null) {
      return { ok: false, reason: 'duplicate_event' };
    }
  }

  const messageSeq = await allocateMessageSeq(redis, tenantId, sessionId);

  const metadata: RoomMessageMetadata = {
    messageSeq,
    actorUserId: input.actorUserId,
    body: input.body,
    wakeHelmsman: input.wakeHelmsman === true,
    ...(input.actorDisplayName ? { actorDisplayName: input.actorDisplayName } : {}),
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
  };

  const eventId = input.eventId ?? crypto.randomUUID();
  const now = Date.now();
  await appendSessionEvent(redis, tenantId, sessionId, {
    eventId,
    eventType: 'RoomMessage',
    timestamp: now,
    sessionId,
    metadata,
  });

  // Speaking in the room is activity in the conversation whether or not it
  // wakes the agent — two people working something out between themselves is
  // the conversation. Rides the pipeline that was already arming the
  // projection, so the clock and the metadata refresh cost nothing extra.
  const pipeline = redis.pipeline();
  pipeline.hset(StreamKeys.sessionStateKey(tenantId, sessionId), 'lastActivityAt', String(now));
  markProjectionCandidate(pipeline, sessionCandidateMember(tenantId, sessionId));
  syncSessionMetadataCandidate(pipeline, tenantId, sessionId, now, now);
  await pipeline.exec();

  return { ok: true, messageSeq, eventId };
}
