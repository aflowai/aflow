import type { Redis } from 'ioredis';
import { StreamKeys, ConsumerGroups } from '@aflow/schemas';
import type { PendingEntry, StreamEntry } from './types.js';
// ============================================================================

export type ShardStreamType = 'control' | 'results';

/**
 * List pending messages on a shard stream that have been idle longer than minIdleMs.
 * Uses XPENDING with IDLE filter to find messages from stale consumers.
 */
export async function listShardPendingMessages(
  redis: Redis,
  shardId: number,
  streamType: ShardStreamType,
  options: { minIdleMs?: number; count?: number } = {},
): Promise<PendingEntry[]> {
  const { minIdleMs = 30_000, count = 100 } = options;

  const streamKey =
    streamType === 'control'
      ? StreamKeys.shardControlStream(shardId)
      : StreamKeys.shardResultsStream(shardId);
  const groupName =
    streamType === 'control' ? ConsumerGroups.orchestratorControl : ConsumerGroups.orchestrator;

  // XPENDING key group IDLE minIdleMs start end count
  const raw = (await redis.call(
    'XPENDING',
    streamKey,
    groupName,
    'IDLE',
    minIdleMs,
    '-',
    '+',
    count,
  )) as Array<[string, string, number, number]>;

  return raw.map(([id, consumer, idleTime, deliveryCount]) => ({
    id,
    consumer,
    idleTime,
    deliveryCount,
  }));
}

/**
 * Claim pending messages on a shard stream for a new consumer.
 * Uses XCLAIM to transfer ownership of specific message IDs.
 * Returns the claimed messages with their fields.
 */
export async function claimShardPendingMessages(
  redis: Redis,
  shardId: number,
  streamType: ShardStreamType,
  consumerName: string,
  messageIds: string[],
  options: { minIdleMs?: number } = {},
): Promise<StreamEntry[]> {
  if (messageIds.length === 0) return [];

  const { minIdleMs = 30_000 } = options;

  const streamKey =
    streamType === 'control'
      ? StreamKeys.shardControlStream(shardId)
      : StreamKeys.shardResultsStream(shardId);
  const groupName =
    streamType === 'control' ? ConsumerGroups.orchestratorControl : ConsumerGroups.orchestrator;

  // XCLAIM key group consumer min-idle-time id [id ...]
  const raw = (await redis.xclaim(
    streamKey,
    groupName,
    consumerName,
    minIdleMs,
    ...messageIds,
  )) as Array<[string, string[]]>;

  return raw.map(([id, flatFields]) => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < flatFields.length; i += 2) {
      const key = flatFields[i];
      const val = flatFields[i + 1];
      if (key !== undefined && val !== undefined) {
        fields[key] = val;
      }
    }
    return { id, fields };
  });
}
