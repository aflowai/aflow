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
  type RoomMessageEventInput,
} from '@aflow/database';
import { appendRoomMessage, HOT_STATE_TTL_SECONDS, markSeenThroughMessage } from '@aflow/redis';
import { StreamKeys, type TenantId } from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';

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
  /** Posted, and durably readable by the turn the run's ending wakes. */
  | { eventId: string; messageSeq: number }
  /** Posted live, but its durable row is still owed — see `settleOwedRoomMessages`. */
  | { eventId: string; durableOwed: true }
  /** This delivery was posted already, and its durable row is written. */
  | { eventId: string; duplicate: true };

type OwedRow = Omit<RoomMessageEventInput, 'postedAt'> & { postedAt: number };

/**
 * The durable rows a session's queued messages still owe, by event id. Kept
 * beside the session's hot state and under the same expiry: the turn that
 * settles them runs only while that state exists, and once it is gone the
 * flush worker has projected the stream entries themselves into the log.
 */
function owedRowsKey(tenantId: TenantId, sessionId: string): string {
  return `${StreamKeys.sessionStateKey(tenantId, sessionId)}:room_owed`;
}

async function writeDurableRow(db: PostgresJsDatabase, tenantId: TenantId, row: OwedRow) {
  await withTenantSchema(db, createTenantContext(tenantId), (tx) =>
    persistRoomMessageEvent(tx, { ...row, postedAt: new Date(row.postedAt) }),
  );
}

/**
 * Write the durable rows a session's queued messages still owe — every one, or
 * only `eventId`'s — forgetting each once written. Returns the event ids still
 * owed. Never throws: a row that fails again stays recorded for the next
 * settlement.
 */
export async function settleOwedRoomMessages(
  db: PostgresJsDatabase,
  redis: Redis,
  tenantId: TenantId,
  sessionId: string,
  eventId?: string,
): Promise<string[]> {
  const key = owedRowsKey(tenantId, sessionId);
  let owed: Array<[string, string]>;
  try {
    if (eventId) {
      const serialized = await redis.hget(key, eventId);
      owed = serialized === null ? [] : [[eventId, serialized]];
    } else {
      owed = Object.entries(await redis.hgetall(key));
    }
  } catch (err) {
    getOrchestratorLogger().warn(
      `[queuedMessage] Could not read the room rows ${sessionId} owes: ${errorText(err)}`,
    );
    return eventId ? [eventId] : [];
  }
  const stillOwed: string[] = [];
  for (const [owedId, serialized] of owed) {
    try {
      await writeDurableRow(db, tenantId, JSON.parse(serialized) as OwedRow);
      await redis.hdel(key, owedId);
    } catch (err) {
      stillOwed.push(owedId);
      getOrchestratorLogger().warn(
        `[queuedMessage] Room message ${owedId} in ${sessionId} still owes its durable row: ${errorText(err)}`,
      );
    }
  }
  return stillOwed;
}

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
 *
 * Once the stream append has succeeded this never throws: a failed durable
 * write must not fail a conversation that is only waiting on its run. The row
 * is recorded as owed before it is written and forgotten once it is, so a
 * failed write — or a crash between the two — leaves it owed. In that state a
 * redelivery of the same resume finds the append's guard taken and writes the
 * owed row before it reports `duplicate`; where the write fails again it
 * reports the row still owed, never `duplicate`. With no redelivery, the
 * conversation's next turn — the one the run's ending wakes — settles every
 * owed row before it reads the room (`agentTurn`).
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
    if (appended.reason !== 'duplicate_event') return undefined;
    const stillOwed = await settleOwedRoomMessages(
      db,
      redis,
      args.tenantId,
      args.sessionId,
      eventId,
    );
    return stillOwed.length > 0 ? { eventId, durableOwed: true } : { eventId, duplicate: true };
  }

  // The API's room post writes through this same @aflow/database writer —
  // extracted there rather than imported from server-runtime, which the
  // orchestrator sits below. Keyed by the stream event's id, so the projection
  // that later flushes the stream finds the row already written.
  const row: OwedRow = {
    eventId: appended.eventId,
    sessionId: args.sessionId,
    messageSeq: appended.messageSeq,
    actorUserId: args.actorUserId,
    body: args.body,
    wakeHelmsman: true,
    postedAt: Date.now(),
    ...(args.actorDisplayName ? { actorDisplayName: args.actorDisplayName } : {}),
    ...(args.clientMessageId ? { clientMessageId: args.clientMessageId } : {}),
  };
  const owedKey = owedRowsKey(args.tenantId, args.sessionId);
  try {
    // Recorded straight after the append, ahead of everything else, so the
    // only crash that leaves a row neither written nor owed falls between
    // these two calls — and that message is still on the stream, which the
    // flush worker projects into the log for a later turn to read.
    await redis
      .multi()
      .hset(owedKey, row.eventId, JSON.stringify(row))
      .expire(owedKey, HOT_STATE_TTL_SECONDS)
      .exec();
  } catch (err) {
    getOrchestratorLogger().warn(
      `[queuedMessage] Could not record room message ${row.eventId} as owed: ${errorText(err)}`,
    );
  }
  try {
    await markSeenThroughMessage(
      redis,
      args.tenantId,
      args.sessionId,
      args.actorUserId,
      appended.messageSeq,
    );
  } catch (err) {
    // The sender reading their own message as unread is cosmetic; failing a
    // resume whose message is posted would have it sent again.
    getOrchestratorLogger().warn(
      `[queuedMessage] Could not mark room message ${row.eventId} seen by its sender: ${errorText(err)}`,
    );
  }

  try {
    await writeDurableRow(db, args.tenantId, row);
  } catch (err) {
    getOrchestratorLogger().warn(
      `[queuedMessage] Durable write for queued message ${row.eventId} failed; it stays owed: ${errorText(err)}`,
    );
    return { eventId: row.eventId, durableOwed: true };
  }
  try {
    await redis.hdel(owedKey, row.eventId);
  } catch {
    // A row left recorded after it was written costs one more write, which
    // the insert ignores: it is keyed by its own id.
  }
  return { eventId: appended.eventId, messageSeq: appended.messageSeq };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
