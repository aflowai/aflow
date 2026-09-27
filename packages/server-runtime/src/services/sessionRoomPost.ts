/**
 * Posting into a session's room and waking a cold one — the Plan 260 path
 * (rehydration, stream append, seen marker, durable head start) shared by
 * the user-facing service method and the applet effects relay. Split from
 * sessions.ts, which re-exports everything here for its existing callers.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { RoomMessageMetadata, SessionId, TenantId } from '@aflow/schemas';
import { eventLog, withTenantSchema, createTenantContext } from '@aflow/database';
import { appendRoomMessage, getSessionStateSafe, markSeenThroughMessage } from '@aflow/redis';
import { rehydratePausedRun } from '@aflow/cybernetic-runtime';

export { rehydratePausedRun };

export interface PostRoomMessageResponse {
  messageSeq: number;
  eventId: string;
  postedAt: string;
  /** The idempotency guard saw this eventId already — the original post stands. */
  duplicate?: boolean;
}

/**
 * A room post addressed by ids rather than a request's ActorContext, so
 * platform relays narrating an already-committed fact (the applet effects
 * relay) can attribute the message to the actor on the record instead of
 * whoever's request happened to trigger the drain.
 */
export interface DirectRoomMessageInput {
  tenantId: TenantId;
  sessionId: SessionId;
  actorUserId: string;
  actorDisplayName?: string;
  body: string;
  clientMessageId?: string;
  /** Deterministic id makes the delivery idempotent — see AppendRoomMessageInput. */
  eventId?: string;
  wakeHelmsman?: boolean;
}

/**
 * Write a room message straight to the durable log.
 *
 * Keyed by the event id the stream append already used, so the flush worker —
 * which skips events it finds already written — treats this as the same event
 * rather than a second copy.
 */
async function persistRoomMessageEvent(
  db: PostgresJsDatabase,
  input: DirectRoomMessageInput,
  appended: { messageSeq: number; eventId: string },
  postedAt: Date,
): Promise<void> {
  const metadata: RoomMessageMetadata = {
    messageSeq: appended.messageSeq,
    actorUserId: input.actorUserId,
    body: input.body,
    wakeHelmsman: input.wakeHelmsman === true,
    ...(input.actorDisplayName ? { actorDisplayName: input.actorDisplayName } : {}),
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
  };

  const envelope = {
    eventId: appended.eventId,
    eventType: 'RoomMessage',
    timestamp: postedAt.getTime(),
    sessionId: input.sessionId,
    metadata,
  };

  try {
    await withTenantSchema(db, createTenantContext(input.tenantId), async (tx) => {
      await tx
        .insert(eventLog)
        .values({
          eventId: appended.eventId,
          eventType: 'RoomMessage',
          sessionId: input.sessionId,
          timestamp: postedAt,
          idempotencyKey: `${appended.eventId}:posted`,
          envelope,
        })
        .onConflictDoNothing();
    });
  } catch (err) {
    // The message is already live on the stream and will still be flushed with
    // the session; losing the durable head start is worse than failing the post.
    console.warn(
      `[sessions] Durable write for room message ${appended.eventId} failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Post a message into a session's room. The full Plan 260 path — cold-room
 * rehydration, stream append, seen marker, durable head start — shared by the
 * user-facing service method and the applet effects relay.
 */
export async function postRoomMessageDirect(
  redis: Redis,
  db: PostgresJsDatabase,
  input: DirectRoomMessageInput,
): Promise<PostRoomMessageResponse> {
  // A long-paused room is cold, not gone: the same snapshot that lets a
  // resume find it lets a teammate talk in it.
  const stateResult = await getSessionStateSafe(redis, input.tenantId, input.sessionId);
  if (!stateResult.ok) {
    const rehydrated = await rehydratePausedRun(redis, db, input.tenantId, input.sessionId);
    if (!rehydrated) {
      const err = new Error(`Session ${input.sessionId} is not open for messages`);
      Object.assign(err, { statusCode: 409 });
      throw err;
    }
  }

  const result = await appendRoomMessage(redis, input.tenantId, input.sessionId, {
    actorUserId: input.actorUserId,
    body: input.body,
    ...(input.wakeHelmsman ? { wakeHelmsman: true } : {}),
    ...(input.actorDisplayName ? { actorDisplayName: input.actorDisplayName } : {}),
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
    ...(input.eventId ? { eventId: input.eventId } : {}),
  });

  if (!result.ok) {
    if (result.reason === 'duplicate_event') {
      // Only deterministic-eventId callers (the effects relay) can land here,
      // and for them a duplicate IS success: the racing winner posted it.
      return {
        messageSeq: 0,
        eventId: input.eventId!,
        postedAt: new Date().toISOString(),
        duplicate: true,
      };
    }
    const err = new Error(`Session ${input.sessionId} is not open for messages`);
    Object.assign(err, { statusCode: 409 });
    throw err;
  }

  // Saying something is having read up to it — otherwise the sender's own
  // message comes back as unread mail from themselves.
  await markSeenThroughMessage(
    redis,
    input.tenantId,
    input.sessionId,
    input.actorUserId,
    result.messageSeq,
  );

  const postedAt = new Date();

  // The hot stream is capped, and one long agent turn emits enough
  // streaming deltas to push a message out of it before the session next
  // rests and flushes. What someone said is durable content, so it goes to
  // Postgres now rather than waiting for a flush that may arrive too late.
  // The flush worker skips events already written, so this does not
  // duplicate.
  await persistRoomMessageEvent(db, input, result, postedAt);

  return {
    messageSeq: result.messageSeq,
    eventId: result.eventId,
    postedAt: postedAt.toISOString(),
  };
}
