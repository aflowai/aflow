import type { Redis } from 'ioredis';
import { LAST_SEEN_TTL_SECONDS, StreamKeys, type CatchUpDelta } from '@aflow/schemas';
import { readSessionEvents } from './hotState/events.js';
import { allocateMessageSeq } from './hotState/roomMessages.js';
import type { SessionHotState } from './hotState/schemas.js';

/** How far back to look for what the run did. A reader wants the shape, not the archive. */
const MAX_EVENTS_SCANNED = 500;

/**
 * Where someone got to in a room: a position in the conversation, and a
 * position in the event log.
 *
 * The two answer different questions and neither substitutes for the other.
 * Messages are counted from `messageSeq`, because the event log is dominated
 * by streaming deltas — one long agent turn emits hundreds of them, so any
 * count that walked the log would report nothing in exactly the busy rooms
 * this exists for. The stream id is what the run's own activity is measured
 * from, where walking the log is the point.
 */
export interface SeenMarker {
  streamId: string;
  messageSeq: number;
}

export async function readLastSeen(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  userId: string,
): Promise<SeenMarker | null> {
  const raw = await redis.get(StreamKeys.sessionLastSeenKey(tenantId, sessionId, userId));
  if (!raw) return null;
  const [streamId = '0', seq = '0'] = raw.split('|');
  return { streamId, messageSeq: Number.parseInt(seq, 10) || 0 };
}

/**
 * Remember where someone got to.
 *
 * The log position is a stream id, not a timestamp: it is compared against
 * event ids, and clocks between a browser and the server do not agree closely
 * enough to decide what someone has already read.
 */
export async function markSeen(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  userId: string,
  marker: SeenMarker,
): Promise<void> {
  await redis.set(
    StreamKeys.sessionLastSeenKey(tenantId, sessionId, userId),
    `${marker.streamId}|${String(marker.messageSeq)}`,
    'EX',
    LAST_SEEN_TTL_SECONDS,
  );
}

/**
 * Writing in a room is reading it: whoever just said something has, by
 * definition, seen everything up to their own message. Called where a message
 * takes its position, so nobody is told they have unread mail of their own.
 */
export async function markSeenThroughMessage(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  userId: string,
  messageSeq: number,
): Promise<void> {
  const existing = await readLastSeen(redis, tenantId, sessionId, userId);
  await markSeen(redis, tenantId, sessionId, userId, {
    streamId: existing?.streamId ?? '0',
    messageSeq,
  });
}

/**
 * A human message entering a room: it takes the next position, and its author
 * is read up to it.
 */
export async function takeRoomMessagePosition(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  actorUserId: string | undefined,
): Promise<number> {
  const messageSeq = await allocateMessageSeq(redis, tenantId, sessionId);
  if (actorUserId) {
    await markSeenThroughMessage(redis, tenantId, sessionId, actorUserId, messageSeq);
  }
  return messageSeq;
}

/**
 * What happened in this room since a person last looked.
 *
 * Their own messages are not news to them, which holds because sending marks
 * the sender's own position. A room they have never opened counts in full: the
 * space is what they belong to, and a thread they have not seen is exactly the
 * thing worth telling them about.
 */
export async function buildCatchUpDelta(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  userId: string,
  runState: SessionHotState | null,
  options: { scanActivity?: boolean } = {},
): Promise<{ delta: CatchUpDelta; cursor: SeenMarker }> {
  const lastSeen = await readLastSeen(redis, tenantId, sessionId, userId);
  const lastMessageSeq = runState?.lastMessageSeq ?? 0;

  // A hot session that ages out takes its counter with it and starts again at
  // zero. A marker above the counter therefore refers to positions that no
  // longer exist: it is stale, not ahead, and the only honest reading is that
  // this person has seen nothing of what the room holds now. Clamping it down
  // instead would quietly swallow every message until the count caught up.
  const marker = lastSeen?.messageSeq ?? 0;
  const seenMessageSeq = marker > lastMessageSeq ? 0 : marker;
  const messagesFromOthers = lastMessageSeq - seenMessageSeq;

  const awaitingInput = runState?.status === 'PAUSED';

  let stepsCompleted = 0;
  let stepsFailed = 0;
  let statusNow: string | undefined;
  let streamId = lastSeen?.streamId ?? '0';

  // What the run itself did is only asked on the way into a room, where one
  // bounded walk is affordable. The indexes ask for the message count alone.
  if (options.scanActivity) {
    const { events, lastId } = await readSessionEvents(
      redis,
      tenantId,
      sessionId,
      streamId,
      MAX_EVENTS_SCANNED,
    );
    streamId = lastId;
    for (const event of events) {
      if (event.eventType === 'StepSucceeded') {
        stepsCompleted++;
      } else if (event.eventType === 'StepFailed') {
        stepsFailed++;
      } else if (
        event.eventType === 'SessionCompleted' ||
        event.eventType === 'SessionFailed' ||
        event.eventType === 'SessionCancelled' ||
        event.eventType === 'SessionPaused'
      ) {
        statusNow = runState?.status;
      }
    }
  }

  const hasNews =
    messagesFromOthers > 0 || stepsCompleted > 0 || stepsFailed > 0 || statusNow !== undefined;

  return {
    delta: {
      hasNews,
      messagesFromOthers,
      seenMessageSeq,
      stepsCompleted,
      stepsFailed,
      awaitingInput,
      ...(statusNow ? { statusNow } : {}),
    },
    cursor: { streamId, messageSeq: lastMessageSeq },
  };
}
