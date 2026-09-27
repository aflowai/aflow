/**
 * Redis Streams helpers for memory embedding jobs.
 * Handles publishing embedding jobs and consuming from the embedding queue.
 */
import type { Redis } from 'ioredis';
import { MemoryEmbedJobSchema, StreamKeys, type MemoryEmbedJob } from '@aflow/schemas';
import type { BlockingRedisConnection } from './connection.js';
import { serializeMessage, deserializeMessage } from './streams.js';

// ============================================================================
// Consumer Group
// ============================================================================

export const MEMORY_EMBED_CONSUMER_GROUP = 'memory-embedder' as const;

/**
 * Ensure the memory embedding consumer group exists.
 */
export async function ensureMemoryEmbedConsumerGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup(
      'CREATE',
      StreamKeys.memoryEmbedStream,
      MEMORY_EMBED_CONSUMER_GROUP,
      '0',
      'MKSTREAM',
    );
  } catch (error) {
    // Group already exists - this is fine
    if (error instanceof Error && error.message.includes('BUSYGROUP')) {
      return;
    }
    throw error;
  }
}

// ============================================================================
// Publishing Embedding Jobs
// ============================================================================

/**
 * Publish a memory embedding job to the queue.
 * Validates the job schema before publishing.
 */
export async function publishMemoryEmbedJob(redis: Redis, job: MemoryEmbedJob): Promise<string> {
  // Validate the job message
  const validatedJob = MemoryEmbedJobSchema.parse(job);

  const fields = serializeMessage(validatedJob);

  // XADD with auto-generated ID
  const messageId = await redis.xadd(StreamKeys.memoryEmbedStream, '*', ...fields);
  if (messageId === null) {
    throw new Error('Failed to publish memory embedding job');
  }
  return messageId;
}

// ============================================================================
// Consuming Embedding Jobs
// ============================================================================

export async function readMemoryEmbedJobs(
  redis: BlockingRedisConnection,
  consumerName: string,
  options: {
    count?: number;
    blockMs?: number;
  } = {},
): Promise<Array<{ id: string; job: MemoryEmbedJob }>> {
  const count = options.count ?? 10;
  const blockMs = options.blockMs ?? 5000;

  const result = await redis.xreadgroup(
    'GROUP',
    MEMORY_EMBED_CONSUMER_GROUP,
    consumerName,
    'COUNT',
    count,
    'BLOCK',
    blockMs,
    'STREAMS',
    StreamKeys.memoryEmbedStream,
    '>',
  );

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- ioredis XREADGROUP returns null on timeout
  if (!result) {
    return [];
  }

  const jobs: Array<{ id: string; job: MemoryEmbedJob }> = [];

  const typedResult = result as Array<[string, Array<[string, string[]]>]>;
  for (const streamData of typedResult) {
    const entries = streamData[1];
    for (const [id, fields] of entries) {
      // Convert flat array to object
      const fieldObj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i];
        const value = fields[i + 1];
        if (key !== undefined && value !== undefined) {
          fieldObj[key] = value;
        }
      }

      const message = deserializeMessage(fieldObj);
      const parseResult = MemoryEmbedJobSchema.safeParse(message);

      if (parseResult.success) {
        jobs.push({ id, job: parseResult.data });
      } else {
        console.error(
          `Invalid memory embed job message in stream ${StreamKeys.memoryEmbedStream}:`,
          parseResult.error,
        );
      }
    }
  }

  return jobs;
}

/**
 * Acknowledge a processed embedding job.
 */
export async function ackMemoryEmbedJob(redis: Redis, messageId: string): Promise<void> {
  await redis.xack(StreamKeys.memoryEmbedStream, MEMORY_EMBED_CONSUMER_GROUP, messageId);
}

/**
 * Claim pending embedding jobs from dead consumers.
 */
export async function claimPendingMemoryEmbedJobs(
  redis: Redis,
  consumerName: string,
  options: {
    minIdleMs?: number;
    count?: number;
  } = {},
): Promise<Array<{ id: string; job: MemoryEmbedJob }>> {
  const minIdleMs = options.minIdleMs ?? 60_000;
  const count = options.count ?? 10;

  const result = await redis.xautoclaim(
    StreamKeys.memoryEmbedStream,
    MEMORY_EMBED_CONSUMER_GROUP,
    consumerName,
    minIdleMs,
    '0-0',
    'COUNT',
    count,
  );

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!result || !Array.isArray(result) || result.length < 2) {
    return [];
  }

  const entries = result[1] as Array<[string, string[]]>;
  if (!Array.isArray(entries)) {
    return [];
  }

  const jobs: Array<{ id: string; job: MemoryEmbedJob }> = [];

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }

    const [id, fields] = entry;
    if (!Array.isArray(fields)) {
      continue;
    }

    const fieldObj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];
      if (key !== undefined && value !== undefined) {
        fieldObj[key] = value;
      }
    }

    const message = deserializeMessage(fieldObj);
    const parseResult = MemoryEmbedJobSchema.safeParse(message);

    if (parseResult.success) {
      jobs.push({ id, job: parseResult.data });
    } else {
      console.warn(`Invalid claimed memory embed job ${id}:`, parseResult.error.message);
    }
  }

  return jobs;
}

/**
 * Publish a failed embedding job to the DLQ.
 */
export async function publishMemoryEmbedJobToDlq(
  redis: Redis,
  originalJob: MemoryEmbedJob,
  error: {
    code: string;
    message: string;
    retryCount?: number;
    details?: Record<string, unknown>;
  },
): Promise<string> {
  const dlqMessage = {
    ...originalJob,
    dlqReason: error.code,
    dlqMessage: error.message,
    dlqRetryCount: error.retryCount ?? 0,
    dlqDetails: error.details,
    dlqAt: new Date().toISOString(),
  };

  const fields = serializeMessage(dlqMessage);
  const messageId = await redis.xadd(StreamKeys.memoryEmbedDlqStream, '*', ...fields);
  if (messageId === null) {
    throw new Error('Failed to publish memory embedding job to DLQ');
  }
  return messageId;
}
