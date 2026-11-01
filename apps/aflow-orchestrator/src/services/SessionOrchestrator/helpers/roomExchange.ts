import { and, desc, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, eventLog, withTenantSchema } from '@aflow/database';
import {
  ROOM_EXCHANGE_MAX_ENTRIES,
  RoomMessageMetadataSchema,
  type RoomExchangeEntry,
  type RoomSpeaker,
  type TenantId,
  WAIT_OUTCOME_ACTOR_ID,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';

/**
 * What people have said in the room, most recent last.
 *
 * Read from the durable event log rather than the Redis stream: the two hold
 * the same events, but the stream is dominated by the agent's own streaming
 * deltas, so a bounded scan of it comes back full of the agent's typing and
 * empty of what anyone said. The log can ask for the one event type.
 *
 * Deliberately uncursored. The conversation store already ignores an input it
 * has seen before, keyed by id, so handing it the recent window every turn
 * delivers each message exactly once without a second cursor to advance,
 * lose on a failed turn, or disagree with what the agent actually read.
 *
 * Ordered by position in the conversation, not by time — the position is
 * allocated at append and is the only cursor that means the same thing on
 * both sides of the Redis-to-Postgres boundary.
 */
export async function readRoomExchange(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  sessionId: string,
): Promise<{ entries: RoomExchangeEntry[]; latestSpeaker: RoomSpeaker | undefined }> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId), (tx) =>
    tx
      .select({ eventType: eventLog.eventType, envelope: eventLog.envelope })
      .from(eventLog)
      .where(
        and(
          eq(eventLog.sessionId, sessionId),
          inArray(eventLog.eventType, ['RoomMessage', 'SessionStarted', 'SessionResumed']),
        ),
      )
      .orderBy(desc(eventLog.timestamp))
      .limit(ROOM_EXCHANGE_MAX_ENTRIES),
  );

  const entries: RoomExchangeEntry[] = [];
  let latestSpeaker: RoomSpeaker | undefined;

  for (const row of rows) {
    const metadata = (row.envelope as { metadata?: unknown } | null)?.metadata;
    if (row.eventType === 'RoomMessage') {
      const parsed = RoomMessageMetadataSchema.safeParse(metadata);
      if (!parsed.success) continue;
      entries.push({
        messageSeq: parsed.data.messageSeq,
        actorUserId: parsed.data.actorUserId,
        ...(parsed.data.actorDisplayName ? { actorDisplayName: parsed.data.actorDisplayName } : {}),
        body: parsed.data.body,
      });
      continue;
    }

    // Starting or steering a session is also speaking in its room — it is
    // simply the message that made the agent run. Rows are newest-first, so
    // the first one seen is the person the current turn is answering.
    const speaker = readSpeaker(metadata);
    if (speaker && !latestSpeaker) latestSpeaker = speaker;
  }

  // Newest-first out of the database so the bound keeps the recent end — a
  // room that ran away while the agent worked still delivers the part someone
  // is waiting on — then back into reading order.
  entries.sort((a, b) => a.messageSeq - b.messageSeq);
  return { entries, latestSpeaker };
}

/**
 * Whether the room holds a wait's outcome the turn that ran on
 * `turnInputRef` did not read.
 *
 * Every turn is handed the recent window of the room, so what a turn read is
 * what its input carried: an outcome in the window now and not in that input
 * was posted after the input was built, while the turn was in flight. Nothing
 * else wakes the conversation for it once that turn comes to rest.
 */
export async function hasUnreadWaitOutcomes(
  db: PostgresJsDatabase,
  payloadStore: Pick<PayloadStore, 'retrieve'>,
  tenantId: TenantId,
  sessionId: string,
  turnInputRef: string | undefined,
): Promise<boolean> {
  const { entries } = await readRoomExchange(db, tenantId, sessionId);
  const outcomes = entries.filter((entry) => entry.actorUserId === WAIT_OUTCOME_ACTOR_ID);
  if (outcomes.length === 0) return false;
  const read = new Set<number>();
  if (turnInputRef !== undefined) {
    const input: unknown = await payloadStore.retrieve(turnInputRef).catch(() => undefined);
    const handed =
      input !== null && typeof input === 'object'
        ? (input as Record<string, unknown>)['newRoomMessages']
        : undefined;
    if (Array.isArray(handed)) {
      for (const entry of handed as unknown[]) {
        const messageSeq =
          entry !== null && typeof entry === 'object'
            ? (entry as Record<string, unknown>)['messageSeq']
            : undefined;
        if (typeof messageSeq === 'number') read.add(messageSeq);
      }
    }
  }
  return outcomes.some((entry) => !read.has(entry.messageSeq));
}

/** Who a session-lifecycle event says was speaking, when it says so at all. */
function readSpeaker(metadata: unknown): RoomSpeaker | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const record = metadata as Record<string, unknown>;
  const actorUserId = record['actorUserId'];
  if (typeof actorUserId !== 'string') return undefined;
  const displayName = record['actorDisplayName'];
  return {
    actorUserId,
    ...(typeof displayName === 'string' ? { actorDisplayName: displayName } : {}),
  };
}
