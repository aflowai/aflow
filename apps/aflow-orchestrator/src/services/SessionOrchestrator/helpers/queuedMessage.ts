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
import {
  createTenantContext,
  deterministicRoomMessageEventId,
  persistRoomMessageEvent,
  withTenantSchema,
} from '@aflow/database';
import { appendRoomMessage, markSeenThroughMessage } from '@aflow/redis';
import type { TenantId } from '@aflow/schemas';

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

export type QueuedMessage =
  | { eventId: string; messageSeq: number }
  /** This delivery was posted already; the first post stands. */
  | { eventId: string; duplicate: true };

/**
 * Post the message into the room — on the live stream for the people in it,
 * and in the durable log the turn builder reads, since the stream is
 * projected only once the conversation next rests. Undefined where the
 * session's hot state is gone, so nothing was posted.
 *
 * The event id is derived from the resume's idempotency key rather than its
 * clientMessageId: the key is always present and is what a redelivered
 * resume carries unchanged, so the same delivery posts once — the stream
 * append's guard refuses the second, and the durable row is keyed by it too.
 */
export async function queueMessageForNextTurn(
  db: PostgresJsDatabase,
  redis: Redis,
  args: {
    tenantId: TenantId;
    sessionId: string;
    /** The resume's idempotency key — what identifies this delivery. */
    deliveryKey: string;
    actorUserId: string;
    actorDisplayName?: string;
    body: string;
    clientMessageId?: string;
  },
): Promise<QueuedMessage | undefined> {
  const eventId = deterministicRoomMessageEventId(
    `queued-resume:${args.sessionId}:${args.deliveryKey}`,
  );
  const appended = await appendRoomMessage(redis, args.tenantId, args.sessionId, {
    actorUserId: args.actorUserId,
    body: args.body,
    wakeHelmsman: true,
    eventId,
    ...(args.actorDisplayName ? { actorDisplayName: args.actorDisplayName } : {}),
    ...(args.clientMessageId ? { clientMessageId: args.clientMessageId } : {}),
  });
  if (!appended.ok) {
    return appended.reason === 'duplicate_event' ? { eventId, duplicate: true } : undefined;
  }
  await markSeenThroughMessage(
    redis,
    args.tenantId,
    args.sessionId,
    args.actorUserId,
    appended.messageSeq,
  );

  // The API's room post writes through this same @aflow/database writer —
  // extracted there rather than imported from server-runtime, which the
  // orchestrator sits below. Keyed by the stream event's id, so the projection
  // that later flushes the stream finds the row already written.
  await withTenantSchema(db, createTenantContext(args.tenantId), (tx) =>
    persistRoomMessageEvent(tx, {
      eventId: appended.eventId,
      sessionId: args.sessionId,
      messageSeq: appended.messageSeq,
      actorUserId: args.actorUserId,
      body: args.body,
      wakeHelmsman: true,
      postedAt: new Date(),
      ...(args.actorDisplayName ? { actorDisplayName: args.actorDisplayName } : {}),
      ...(args.clientMessageId ? { clientMessageId: args.clientMessageId } : {}),
    }),
  );
  return { eventId: appended.eventId, messageSeq: appended.messageSeq };
}
