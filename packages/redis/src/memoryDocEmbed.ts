/**
 * Redis Streams helpers for memory v2 doc embedding jobs.
 * Publishes/consumes chunked embedding work for the memory doc store.
 */
import type { Redis } from 'ioredis';
import { MemoryDocEmbedJobSchema, StreamKeys, type MemoryDocEmbedJob } from '@aflow/schemas';
import type { BlockingRedisConnection } from './connection.js';
import { serializeMessage, deserializeMessage } from './streams.js';

export const MEMORY_DOC_EMBED_CONSUMER_GROUP = 'memory-doc-embedder' as const;

export async function ensureMemoryDocEmbedConsumerGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup(
      'CREATE',
      StreamKeys.memoryDocEmbedStream,
      MEMORY_DOC_EMBED_CONSUMER_GROUP,
      '0',
      'MKSTREAM',
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('BUSYGROUP')) {
      return;
    }
    throw error;
  }
}

export async function publishMemoryDocEmbedJob(
  redis: Redis,
  job: MemoryDocEmbedJob,
): Promise<string> {
  const validated = MemoryDocEmbedJobSchema.parse(job);
  const fields = serializeMessage(validated);
  const messageId = await redis.xadd(StreamKeys.memoryDocEmbedStream, '*', ...fields);
  if (messageId === null) {
    throw new Error('Failed to publish memory doc embedding job');
  }
  return messageId;
}

export async function readMemoryDocEmbedJobs(
  redis: BlockingRedisConnection,
  consumerName: string,
  options: { count?: number; blockMs?: number } = {},
): Promise<Array<{ id: string; job: MemoryDocEmbedJob }>> {
  const count = options.count ?? 10;
  const blockMs = options.blockMs ?? 5000;

  const result = await redis.xreadgroup(
    'GROUP',
    MEMORY_DOC_EMBED_CONSUMER_GROUP,
    consumerName,
    'COUNT',
    count,
    'BLOCK',
    blockMs,
    'STREAMS',
    StreamKeys.memoryDocEmbedStream,
    '>',
  );

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- ioredis XREADGROUP returns null on timeout
  if (!result) return [];

  const jobs: Array<{ id: string; job: MemoryDocEmbedJob }> = [];

  const typedResult = result as Array<[string, Array<[string, string[]]>]>;
  for (const streamData of typedResult) {
    const entries = streamData[1];
    for (const [id, fields] of entries) {
      const fieldObj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i];
        const value = fields[i + 1];
        if (key !== undefined && value !== undefined) {
          fieldObj[key] = value;
        }
      }

      const message = deserializeMessage(fieldObj);
      const parseResult = MemoryDocEmbedJobSchema.safeParse(message);

      if (parseResult.success) {
        jobs.push({ id, job: parseResult.data });
      } else {
        console.error('Invalid memory doc embed job:', parseResult.error.message);
      }
    }
  }

  return jobs;
}

export async function ackMemoryDocEmbedJob(redis: Redis, messageId: string): Promise<void> {
  await redis.xack(StreamKeys.memoryDocEmbedStream, MEMORY_DOC_EMBED_CONSUMER_GROUP, messageId);
}

export async function claimPendingMemoryDocEmbedJobs(
  redis: Redis,
  consumerName: string,
  options: { minIdleMs?: number; count?: number } = {},
): Promise<Array<{ id: string; job: MemoryDocEmbedJob }>> {
  const minIdleMs = options.minIdleMs ?? 60_000;
  const count = options.count ?? 10;

  const result = await redis.xautoclaim(
    StreamKeys.memoryDocEmbedStream,
    MEMORY_DOC_EMBED_CONSUMER_GROUP,
    consumerName,
    minIdleMs,
    '0-0',
    'COUNT',
    count,
  );

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!result || !Array.isArray(result) || result.length < 2) return [];

  const entries = result[1] as Array<[string, string[]]>;
  if (!Array.isArray(entries)) return [];

  const jobs: Array<{ id: string; job: MemoryDocEmbedJob }> = [];

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) continue;

    const [id, fields] = entry;
    if (!Array.isArray(fields)) continue;

    const fieldObj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];
      if (key !== undefined && value !== undefined) {
        fieldObj[key] = value;
      }
    }

    const message = deserializeMessage(fieldObj);
    const parseResult = MemoryDocEmbedJobSchema.safeParse(message);

    if (parseResult.success) {
      jobs.push({ id, job: parseResult.data });
    }
  }

  return jobs;
}
