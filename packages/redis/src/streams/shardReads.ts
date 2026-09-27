import type { Redis } from 'ioredis';
import {
  StepResultMessageSchema,
  ControlMessageSchema,
  StreamKeys,
  ConsumerGroups,
  type StepResultMessage,
  type ControlMessage,
} from '@aflow/schemas';
import type { BlockingRedisConnection } from '../connection.js';
import { deserializeMessage } from './serialization.js';
import { armRetentionCandidate, execAckPipeline } from './retention.js';
// ============================================================================

/**
 * The stream keys an owner reads from, plus the inverse lookup used to attribute
 * each XREADGROUP response back to its shard.
 *
 * Derived from shard ownership and rebuilt only when that changes. Building it
 * per read meant allocating 128 formatted keys and a 128-entry Map on every
 * blocking read — ten times a second per consumer, forever, whether or not
 * anything was there to read.
 */
export interface ShardStreamSet {
  readonly streamKeys: readonly string[];
  readonly streamMap: ReadonlyMap<string, number>;
}

function buildShardStreamSet(
  shardIds: readonly number[],
  keyFn: (shardId: number) => string,
): ShardStreamSet {
  const streamMap = new Map<string, number>();
  for (const shardId of shardIds) {
    streamMap.set(keyFn(shardId), shardId);
  }
  return { streamKeys: [...streamMap.keys()], streamMap };
}

export function buildResultStreamSet(shardIds: readonly number[]): ShardStreamSet {
  return buildShardStreamSet(shardIds, StreamKeys.shardResultsStream);
}

export function buildControlStreamSet(shardIds: readonly number[]): ShardStreamSet {
  return buildShardStreamSet(shardIds, StreamKeys.shardControlStream);
}

export const EMPTY_SHARD_STREAM_SET: ShardStreamSet = { streamKeys: [], streamMap: new Map() };

/**
 * Recreate the consumer group on every stream in this read, in one pipeline.
 *
 * `BUSYGROUP` on the ones that already exist is the expected outcome and is
 * ignored; `MKSTREAM` covers a stream that is gone entirely. Starting at `0`
 * rather than `$` so anything still on a surviving stream is redelivered rather
 * than skipped.
 */
async function recreateMissingGroups(
  redis: Redis,
  groupName: string,
  streamKeys: readonly string[],
): Promise<void> {
  const pipeline = redis.pipeline();
  for (const key of streamKeys) {
    pipeline.xgroup('CREATE', key, groupName, '0', 'MKSTREAM');
  }
  await pipeline.exec();
}

async function readFromShardStreams(
  redis: Redis,
  groupName: string,
  consumerName: string,
  streamKeys: readonly string[],
  options: { count?: number; blockMs?: number; cursor?: string },
): Promise<Array<{ id: string; streamKey: string; fields: Record<string, string> }>> {
  if (streamKeys.length === 0) return [];

  const count = options.count ?? 10;
  const cursor = options.cursor ?? '>';

  // When reading pending entries (cursor='0'), don't block — they're already local.
  // When reading new entries (cursor='>'), block for the configured time (omit BLOCK for
  // immediate return — Redis BLOCK 0 means *indefinite* block, not "no wait").
  const cursors = streamKeys.map(() => cursor);
  const args: Array<string | number> = ['GROUP', groupName, consumerName, 'COUNT', count];
  if (cursor === '>') {
    const blockMs = options.blockMs ?? 100;
    if (blockMs > 0) {
      args.push('BLOCK', blockMs);
    }
  }
  args.push('STREAMS', ...streamKeys, ...cursors);

  // Safety timeout: if XREADGROUP hangs, resolve with empty results rather than blocking
  // forever. Pending reads fan out to many shard streams — allow more time on slow dev Redis.
  const blockMsForTimeout = cursor === '>' ? (options.blockMs ?? 100) : 0;
  const timeoutMs =
    cursor === '>'
      ? blockMsForTimeout <= 0
        ? 10_000
        : blockMsForTimeout * 2 + 1000
      : Math.max(30_000, streamKeys.length * 200);
  const timeoutPromise = new Promise<null>((resolve) => setTimeout(resolve, timeoutMs, null));

  const read = async (): Promise<unknown> =>
    Promise.race([
      (redis.xreadgroup as (...a: Array<string | number>) => Promise<unknown>)(...args),
      timeoutPromise,
    ]);

  let result: unknown;
  try {
    result = await read();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // A group can disappear under a running consumer — an evicted stream, a
    // Redis restart without persistence, a failover to a replica that never saw
    // the XGROUP CREATE. Groups are otherwise only created at boot, so without
    // this the consumer logs NOGROUP on every read forever and every result on
    // that shard is silently never processed.
    if (errMsg.includes('NOGROUP')) {
      console.warn(
        `[readFromShardStreams] consumer group missing on one of ${String(streamKeys.length)} streams; recreating`,
      );
      try {
        await recreateMissingGroups(redis, groupName, streamKeys);
        result = await read();
      } catch (retryErr) {
        console.error(
          `[readFromShardStreams] group repair failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
        );
        return [];
      }
    } else {
      console.error(
        `[readFromShardStreams] XREADGROUP error on ${String(streamKeys.length)} streams (cursor=${cursor}): ${errMsg}`,
      );
      return [];
    }
  }

  if (result === null) {
    if (cursor !== '>') {
      // Only warn for non-blocking reads (pending drain) — blocking reads returning null is normal
      console.warn(
        `[readFromShardStreams] XREADGROUP timed out after ${String(timeoutMs)}ms on ${String(streamKeys.length)} streams (cursor=${cursor})`,
      );
    }
    return [];
  }

  if (!result) return [];

  const entries: Array<{ id: string; streamKey: string; fields: Record<string, string> }> = [];
  const typedResult = result as Array<[string, Array<[string, string[]]>]>;

  for (const [streamKey, streamEntries] of typedResult) {
    for (const [id, rawFields] of streamEntries) {
      const fields: Record<string, string> = {};
      for (let i = 0; i < rawFields.length; i += 2) {
        const key = rawFields[i];
        const value = rawFields[i + 1];
        if (key !== undefined && value !== undefined) {
          fields[key] = value;
        }
      }
      entries.push({ id, streamKey, fields });
    }
  }

  return entries;
}

/**
 * Read control messages from shard-scoped control streams.
 * Returns messages with their shardId for correct per-shard ack.
 */
export async function readShardControlMessages(
  redis: BlockingRedisConnection,
  consumerName: string,
  streams: ShardStreamSet,
  options: { count?: number; blockMs?: number } = {},
): Promise<Array<{ id: string; shardId: number; message: ControlMessage }>> {
  const { streamKeys, streamMap } = streams;

  const entries = await readFromShardStreams(
    redis,
    ConsumerGroups.orchestratorControl,
    consumerName,
    streamKeys,
    options,
  );

  const messages: Array<{ id: string; shardId: number; message: ControlMessage }> = [];
  for (const { id, streamKey, fields } of entries) {
    const shardId = streamMap.get(streamKey);
    if (shardId === undefined) continue;

    const raw = deserializeMessage(fields);
    const parsed = ControlMessageSchema.safeParse(raw);
    if (parsed.success) {
      messages.push({ id, shardId, message: parsed.data });
    } else {
      console.error(`Invalid control message in shard stream ${streamKey}:`, parsed.error);
    }
  }

  return messages;
}

/**
 * Read pending (already delivered but not acked) control messages from shard streams.
 * Uses cursor '0' instead of '>' to retrieve entries that were XCLAIM'd or
 * delivered to this consumer but never acked. Non-blocking.
 */
export async function readShardPendingControlMessages(
  redis: Redis,
  consumerName: string,
  streams: ShardStreamSet,
  options: { count?: number } = {},
): Promise<Array<{ id: string; shardId: number; message: ControlMessage }>> {
  const { streamKeys, streamMap } = streams;

  const entries = await readFromShardStreams(
    redis,
    ConsumerGroups.orchestratorControl,
    consumerName,
    streamKeys,
    { count: options.count ?? 50, cursor: '0' },
  );

  const messages: Array<{ id: string; shardId: number; message: ControlMessage }> = [];
  for (const { id, streamKey, fields } of entries) {
    const shardId = streamMap.get(streamKey);
    if (shardId === undefined) continue;

    const raw = deserializeMessage(fields);
    const parsed = ControlMessageSchema.safeParse(raw);
    if (parsed.success) {
      messages.push({ id, shardId, message: parsed.data });
    } else {
      console.error(`Invalid pending control message in shard stream ${streamKey}:`, parsed.error);
    }
  }

  return messages;
}

/**
 * Read pending (already delivered but not acked) step results from shard streams.
 * Uses cursor '0' instead of '>' to retrieve entries that were XCLAIM'd or
 * delivered to this consumer but never acked. Non-blocking.
 */
export async function readShardPendingStepResults(
  redis: Redis,
  consumerName: string,
  streams: ShardStreamSet,
  options: { count?: number } = {},
): Promise<Array<{ id: string; shardId: number; result: StepResultMessage }>> {
  const { streamKeys, streamMap } = streams;

  const entries = await readFromShardStreams(
    redis,
    ConsumerGroups.orchestrator,
    consumerName,
    streamKeys,
    { count: options.count ?? 50, cursor: '0' },
  );

  const results: Array<{ id: string; shardId: number; result: StepResultMessage }> = [];
  for (const { id, streamKey, fields } of entries) {
    const shardId = streamMap.get(streamKey);
    if (shardId === undefined) continue;

    const raw = deserializeMessage(fields);
    const parsed = StepResultMessageSchema.safeParse(raw);
    if (parsed.success) {
      results.push({ id, shardId, result: parsed.data });
    } else {
      console.error(`Invalid pending result message in shard stream ${streamKey}:`, parsed.error);
    }
  }

  return results;
}

/**
 * Ack a control message on its shard-scoped stream.
 */
export async function ackShardControlMessage(
  redis: Redis,
  shardId: number,
  messageId: string,
): Promise<void> {
  const streamKey = StreamKeys.shardControlStream(shardId);
  const pipeline = redis.pipeline().xack(streamKey, ConsumerGroups.orchestratorControl, messageId);
  armRetentionCandidate(pipeline, streamKey);
  await execAckPipeline(pipeline, 1);
}

/**
 * Read step results from shard-scoped result streams.
 * Returns results with their shardId for correct per-shard ack.
 */
export async function readShardStepResults(
  redis: BlockingRedisConnection,
  consumerName: string,
  streams: ShardStreamSet,
  options: { count?: number; blockMs?: number } = {},
): Promise<Array<{ id: string; shardId: number; result: StepResultMessage }>> {
  const { streamKeys, streamMap } = streams;

  const entries = await readFromShardStreams(
    redis,
    ConsumerGroups.orchestrator,
    consumerName,
    streamKeys,
    options,
  );

  const results: Array<{ id: string; shardId: number; result: StepResultMessage }> = [];
  for (const { id, streamKey, fields } of entries) {
    const shardId = streamMap.get(streamKey);
    if (shardId === undefined) continue;

    const raw = deserializeMessage(fields);
    const parsed = StepResultMessageSchema.safeParse(raw);
    if (parsed.success) {
      results.push({ id, shardId, result: parsed.data });
    } else {
      console.error(`Invalid result message in shard stream ${streamKey}:`, parsed.error);
    }
  }

  return results;
}

/**
 * Ack a step result on its shard-scoped stream.
 */
export async function ackShardStepResult(
  redis: Redis,
  shardId: number,
  messageId: string,
): Promise<void> {
  const streamKey = StreamKeys.shardResultsStream(shardId);
  const pipeline = redis.pipeline().xack(streamKey, ConsumerGroups.orchestrator, messageId);
  armRetentionCandidate(pipeline, streamKey);
  await execAckPipeline(pipeline, 1);
}

/**
 * Batch-ack step results across multiple shard streams in a single pipeline.
 */
export async function batchAckShardStepResults(
  redis: Redis,
  entries: Array<{ shardId: number; messageId: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  if (entries.length === 1 && entries[0]) {
    await ackShardStepResult(redis, entries[0].shardId, entries[0].messageId);
    return;
  }
  const pipeline = redis.pipeline();
  const armed = new Set<string>();
  for (const { shardId, messageId } of entries) {
    const streamKey = StreamKeys.shardResultsStream(shardId);
    pipeline.xack(streamKey, ConsumerGroups.orchestrator, messageId);
    armed.add(streamKey);
  }
  for (const streamKey of armed) {
    armRetentionCandidate(pipeline, streamKey);
  }
  await execAckPipeline(pipeline, entries.length);
}
