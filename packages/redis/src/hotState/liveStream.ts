import type { Redis } from 'ioredis';
import { LiveDeltaChannelSchema, StreamKeys, type LiveDeltaChannel } from '@aflow/schemas';
import { HOT_STATE_TTL_SECONDS } from './schemas.js';
import { sessionWakePayload } from './events.js';

/**
 * The live streaming plane: the partial text of the step running right now.
 *
 * Separate from the session event stream because the two have nothing in
 * common but a transport. An event is a log entry — it must survive, it is
 * replayed later, it carries a durable cursor. A delta is a value — it matters
 * only while the step is running, it is superseded by that step's terminal
 * event, and losing one costs nothing. Sharing one capped stream made the
 * durable record's retention a function of how much the model thought.
 *
 * The buffer is a Redis string appended with APPEND, which is O(1) and returns
 * the new length. That length is the cursor: a reader holding offset `n` gets
 * exactly the new bytes with GETRANGE n -1, and a reader arriving late passes 0
 * and gets the whole partial in one read. There is no compaction and therefore
 * no "your cursor was trimmed" case to reconcile.
 */

export type LiveStreamChannel = LiveDeltaChannel;

export interface LiveStreamRead {
  /** Bytes appended since the caller's offset. Empty when nothing is new. */
  delta: string;
  /**
   * The offset to pass on the next read. Advances past what was returned;
   * unchanged from the input when there was nothing new.
   */
  offset: number;
  /**
   * Byte position where `delta` begins. Normally the requested offset; `0` on a
   * restart (see below), which tells the reader to replace rather than append.
   */
  startOffset: number;
}

/**
 * Append to a step's live buffer and wake anyone tailing the session.
 *
 * Returns the buffer's new length — the offset a reader will hold once it has
 * consumed everything written so far.
 *
 * The wakeup rides the same Pub/Sub channel as session events: a watcher is
 * already subscribed to it for the durable plane, so the live plane costs no
 * additional subscription. The payload is a signal, never content.
 *
 * It also rides the same transaction as the append. There is no safety poll
 * behind it any more, so a wake lost on its own leaves streamed text sitting in
 * a buffer until the next durable event happens to wake the reader — which, for
 * a model still streaming its first sentence, is the whole response.
 *
 * A step a workflow dispatched carries a run and a task where a chat step
 * carries a session, so there is no channel to publish on: `sessionId` is null
 * and the wake is published by `publishLiveDeltaWake` once the run's watchers
 * are known. The buffer is keyed by the step either way, which is what makes
 * splitting the two halves possible at all.
 */
export async function appendLiveDelta(
  redis: Redis,
  tenantId: string,
  sessionId: string | null,
  stepExecutionId: string,
  channel: LiveStreamChannel,
  delta: string,
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): Promise<number> {
  const key = StreamKeys.liveStreamBuffer(tenantId, stepExecutionId, channel);
  const pipeline = redis.multi();
  pipeline.append(key, delta);
  pipeline.expire(key, ttlSeconds);
  if (sessionId !== null) {
    pipeline.publish(
      StreamKeys.pubsubChannel(tenantId, sessionId),
      sessionWakePayload(sessionId, `LiveDelta:${channel}`),
    );
  }
  const results = await pipeline.exec();

  const appendResult = results?.[0];
  const length = typeof appendResult?.[1] === 'number' ? appendResult[1] : 0;

  return length;
}

/**
 * Wake the watchers of a step whose own job named no session.
 *
 * Same payload on the same channel as the append's own wake, so a reader cannot
 * tell the two apart — which is the point: the live plane keeps one shape, and
 * only who resolves the audience differs. A signal, never content.
 */
export async function publishLiveDeltaWake(
  redis: Redis,
  tenantId: string,
  sessionIds: readonly string[],
  channel: LiveStreamChannel,
): Promise<void> {
  if (sessionIds.length === 0) return;
  const pipeline = redis.pipeline();
  for (const sessionId of sessionIds) {
    pipeline.publish(
      StreamKeys.pubsubChannel(tenantId, sessionId),
      sessionWakePayload(sessionId, `LiveDelta:${channel}`),
    );
  }
  await pipeline.exec();
}

/**
 * Read whatever has been appended past `offset`.
 *
 * GETRANGE is inclusive of both ends, so `offset` is the first byte not yet
 * seen. A missing key reads as empty — a step that never streamed and a step
 * whose buffer has been cleared are indistinguishable here, which is correct:
 * in both cases there is no live text to show and the durable events are
 * authoritative.
 *
 * The paired STRLEN catches a buffer *restart*: a retryable failure DELetes the
 * buffer and the retry reuses the same `stepExecutionId`, so a reader holding
 * attempt 1's offset would otherwise splice attempt 2 onto it or drop it
 * entirely. When the current length is shorter than the held offset the key
 * cannot be the same value the offset was measured against — the read restarts
 * from `0` and reports `startOffset: 0` so the reader replaces.
 */
export async function readLiveDeltaFrom(
  redis: Redis,
  tenantId: string,
  stepExecutionId: string,
  channel: LiveStreamChannel,
  offset: number,
): Promise<LiveStreamRead> {
  const key = StreamKeys.liveStreamBuffer(tenantId, stepExecutionId, channel);

  const pipeline = redis.pipeline();
  pipeline.strlen(key);
  pipeline.getrange(key, offset, -1);
  const results = await pipeline.exec();
  const length = typeof results?.[0]?.[1] === 'number' ? results[0][1] : 0;
  const tail = typeof results?.[1]?.[1] === 'string' ? results[1][1] : '';

  if (length < offset) {
    const whole = await redis.getrange(key, 0, -1);
    return { delta: whole, offset: Buffer.byteLength(whole), startOffset: 0 };
  }
  if (!tail) return { delta: '', offset, startOffset: offset };
  return { delta: tail, offset: offset + Buffer.byteLength(tail), startOffset: offset };
}

/**
 * Drop a step's live buffers once its terminal event has been written.
 *
 * Called after the durable event, never before: the terminal event is what the
 * client promotes the streamed text into, so clearing first would blank the
 * message for anyone mid-read. The TTL is the backstop for a step that dies
 * without reaching a terminal state.
 */
export async function clearLiveBuffers(
  redis: Redis,
  tenantId: string,
  stepExecutionId: string,
): Promise<void> {
  await redis.del(
    ...LiveDeltaChannelSchema.options.map((channel) =>
      StreamKeys.liveStreamBuffer(tenantId, stepExecutionId, channel),
    ),
  );
}
