/**
 * A message for a conversation whose step is parked on a workflow run it
 * started (Plan 315, "A conversation waiting on a paused run takes a
 * message"): the run's waiter, not a person, completes that step, so the
 * message cannot be its answer. It goes into the room instead, where the
 * conversation's next turn reads what people said while it was away — the
 * turn the run's ending wakes.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { createTenantContext, eventLog, withTenantSchema } from '@aflow/database';
import { appendRoomMessage, markSeenThroughMessage } from '@aflow/redis';
import type { RoomMessageMetadata, TenantId } from '@aflow/schemas';

const CHAT_INPUT_PREFIX = 'ai.agent.chatInput.';

/**
 * The words a resume carries, in any shape a conversation is sent a message
 * in: the text itself, `{ input: text }`, or the text under the chat input
 * variable it would have been mapped to. Undefined for anything else, which
 * says nothing a turn could read.
 */
export function messageOfResumeInput(input: unknown): string | undefined {
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() !== '' ? value : undefined;
  if (typeof input === 'string') return text(input);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if ('input' in record) return messageOfResumeInput(record['input']);
  const chatKeys = Object.keys(record).filter((key) => key.startsWith(CHAT_INPUT_PREFIX));
  return chatKeys.length === 1 ? text(record[chatKeys[0]!]) : undefined;
}

/**
 * Post the message into the room — on the live stream for the people in it,
 * and in the durable log the turn builder reads, since the stream is
 * projected only once the conversation next rests. Undefined where the
 * session's hot state is gone, so nothing was posted.
 */
export async function queueMessageForNextTurn(
  db: PostgresJsDatabase,
  redis: Redis,
  args: {
    tenantId: TenantId;
    sessionId: string;
    actorUserId: string;
    actorDisplayName?: string;
    body: string;
    clientMessageId?: string;
  },
): Promise<{ eventId: string; messageSeq: number } | undefined> {
  const appended = await appendRoomMessage(redis, args.tenantId, args.sessionId, {
    actorUserId: args.actorUserId,
    body: args.body,
    wakeHelmsman: true,
    ...(args.actorDisplayName ? { actorDisplayName: args.actorDisplayName } : {}),
    ...(args.clientMessageId ? { clientMessageId: args.clientMessageId } : {}),
  });
  if (!appended.ok) return undefined;
  await markSeenThroughMessage(
    redis,
    args.tenantId,
    args.sessionId,
    args.actorUserId,
    appended.messageSeq,
  );

  const metadata: RoomMessageMetadata = {
    messageSeq: appended.messageSeq,
    actorUserId: args.actorUserId,
    body: args.body,
    wakeHelmsman: true,
    ...(args.actorDisplayName ? { actorDisplayName: args.actorDisplayName } : {}),
    ...(args.clientMessageId ? { clientMessageId: args.clientMessageId } : {}),
  };
  const postedAt = new Date();
  // Keyed by the stream event's id, so the projection that later flushes the
  // stream finds the row already written rather than adding a second.
  await withTenantSchema(db, createTenantContext(args.tenantId), async (tx) => {
    await tx
      .insert(eventLog)
      .values({
        eventId: appended.eventId,
        eventType: 'RoomMessage',
        sessionId: args.sessionId,
        timestamp: postedAt,
        idempotencyKey: `${appended.eventId}:posted`,
        envelope: {
          eventId: appended.eventId,
          eventType: 'RoomMessage',
          timestamp: postedAt.getTime(),
          sessionId: args.sessionId,
          metadata,
        },
      })
      .onConflictDoNothing();
  });
  return { eventId: appended.eventId, messageSeq: appended.messageSeq };
}
