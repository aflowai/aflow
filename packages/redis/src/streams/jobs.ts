import type { Redis } from 'ioredis';
import {
  StepJobMessageSchema,
  StreamKeys,
  ConsumerGroups,
  codeLaneBreakerRefusal,
  type StepJobMessage,
  type StepType,
} from '@aflow/schemas';
import type { BlockingRedisConnection } from '../connection.js';
import { serializeMessage, deserializeMessage } from './serialization.js';
import { armRetentionCandidate, execAckPipeline, firstReplyString } from './retention.js';
import { hasAvailableExecutor } from './executorHeartbeat.js';
import { NoExecutorAvailableError } from './engineHealth.js';
import type { PendingEntry } from './types.js';
// ============================================================================
// Job Stream Operations (Orchestrator → Executors)
// ============================================================================

/**
 * Add a step job to the appropriate job stream.
 * Throws NoExecutorAvailableError if no executor is registered for this step type.
 * Throws CodeLaneDisabledError if the step type's breaker is open here.
 */
export async function addStepJob(
  redis: Redis,
  job: StepJobMessage,
  options: { checkExecutorAvailable?: boolean } = {},
): Promise<string> {
  // Validate the job message
  const validatedJob = StepJobMessageSchema.parse(job);

  // Every orchestrator dispatch path funnels through here, so a breaker checked
  // here cannot be routed around by a new producer. Refusing before the XADD is
  // the difference between an answer the run can act on and a job that sits in a
  // stream nobody consumes.
  const laneRefusal = codeLaneBreakerRefusal(
    validatedJob.stepType,
    `operation ${validatedJob.operationId}`,
  );
  if (laneRefusal) throw laneRefusal;

  // Check if an executor is available (default: true)
  if (options.checkExecutorAvailable !== false) {
    const available = await hasAvailableExecutor(redis, validatedJob.stepType);
    if (!available) {
      throw new NoExecutorAvailableError(validatedJob.stepType);
    }
  }

  const streamKey = StreamKeys.jobStream(validatedJob.stepType);
  const fields = serializeMessage(validatedJob);

  // Arming on enqueue as well as ack: a lane whose executor is gone produces no
  // further acks, and that is exactly the stream whose growth must stay visible.
  const pipeline = redis.pipeline().xadd(streamKey, '*', ...fields);
  armRetentionCandidate(pipeline, streamKey);
  const messageId = firstReplyString(await pipeline.exec());
  if (messageId === null) {
    throw new Error('Failed to add job to stream');
  }
  return messageId;
}

export async function readStepJobs(
  redis: BlockingRedisConnection,
  stepType: StepType,
  consumerName: string,
  options: {
    count?: number;
    blockMs?: number;
    /** Override stream key (defaults to StreamKeys.jobStream(stepType)) */
    streamKey?: string;
    /** Override consumer group (defaults to ConsumerGroups.executor(stepType)) */
    consumerGroup?: string;
  } = {},
): Promise<Array<{ id: string; job: StepJobMessage }>> {
  const streamKey = options.streamKey ?? StreamKeys.jobStream(stepType);
  const groupName = options.consumerGroup ?? ConsumerGroups.executor(stepType);
  const count = options.count ?? 10;
  const blockMs = options.blockMs ?? 5000;

  // XREADGROUP with blocking
  const result = await redis.xreadgroup(
    'GROUP',
    groupName,
    consumerName,
    'COUNT',
    count,
    'BLOCK',
    blockMs,
    'STREAMS',
    streamKey,
    '>',
  );

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- ioredis XREADGROUP returns null on timeout
  if (!result) {
    return [];
  }

  const jobs: Array<{ id: string; job: StepJobMessage }> = [];

  // Type assertion for ioredis XREADGROUP result
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
      const parseResult = StepJobMessageSchema.safeParse(message);

      if (parseResult.success) {
        jobs.push({ id, job: parseResult.data });
      } else {
        // Log validation error but don't throw
        console.error(`Invalid job message in stream ${streamKey}:`, parseResult.error);
      }
    }
  }

  return jobs;
}

/**
 * Acknowledge a processed job message.
 */
export async function ackStepJob(
  redis: Redis,
  stepType: StepType,
  messageId: string,
  options?: {
    streamKey?: string;
    consumerGroup?: string;
  },
): Promise<void> {
  const streamKey = options?.streamKey ?? StreamKeys.jobStream(stepType);
  const groupName = options?.consumerGroup ?? ConsumerGroups.executor(stepType);
  const pipeline = redis.pipeline().xack(streamKey, groupName, messageId);
  armRetentionCandidate(pipeline, streamKey);
  await execAckPipeline(pipeline, 1);
}

/**
 * A script rather than MULTI, which runs the acknowledgement even when the
 * re-entry failed and so loses the job: here a failed XADD acknowledges
 * nothing, leaving the entry pending for the reclaim, and a failed XACK
 * deletes the entry it just added, so the job is neither lost nor doubled.
 */
const RELEASE_STEP_JOB_LUA = `
local releasedId = redis.call('XADD', KEYS[1], '*', unpack(ARGV, 3))
local acked = redis.pcall('XACK', KEYS[1], ARGV[1], ARGV[2])
if type(acked) == 'table' and acked.err then
  redis.call('XDEL', KEYS[1], releasedId)
  return redis.error_reply(acked.err)
end
return releasedId
`;

/**
 * Hand a claimed job back to its stream unworked, for whichever consumer reads
 * next. Re-entered rather than left pending: the reclaim skips a live consumer
 * and its own name, so a message left in this consumer's pending list would
 * wait on this executor's heartbeat lapsing.
 */
export async function releaseStepJob(
  redis: Redis,
  job: StepJobMessage,
  messageId: string,
): Promise<string> {
  const streamKey = StreamKeys.jobStream(job.stepType);
  const groupName = ConsumerGroups.executor(job.stepType);
  const pipeline = redis
    .pipeline()
    .eval(RELEASE_STEP_JOB_LUA, 1, streamKey, groupName, messageId, ...serializeMessage(job));
  armRetentionCandidate(pipeline, streamKey);
  const releasedId = firstReplyString(await pipeline.exec());
  if (releasedId === null) {
    throw new Error('Failed to release job to stream');
  }
  return releasedId;
}

/**
 * List pending step job entries with owner and idle time.
 * Uses XPENDING with IDLE filter (Redis 6.2+).
 *
 * Use this for dead-consumer-aware reclaim: filter by consumer liveness before claiming.
 */
export async function listPendingStepJobs(
  redis: Redis,
  stepType: StepType,
  options: {
    /** Minimum idle time in ms (only entries idle at least this long) */
    minIdleMs: number;
    /** Maximum entries to return */
    count?: number;
    /** Override stream key */
    streamKey?: string;
    /** Override consumer group */
    consumerGroup?: string;
  },
): Promise<PendingEntry[]> {
  const streamKey = options.streamKey ?? StreamKeys.jobStream(stepType);
  const groupName = options.consumerGroup ?? ConsumerGroups.executor(stepType);
  const count = options.count ?? 50;

  // XPENDING key group IDLE minIdleMs - + count
  // Returns: [[id, consumer, idleTime, deliveryCount], ...]
  const raw = await redis.xpending(
    streamKey,
    groupName,
    'IDLE',
    options.minIdleMs,
    '-',
    '+',
    count,
  );

  if (!Array.isArray(raw)) {
    return [];
  }

  const entries: PendingEntry[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 4) {
      continue;
    }
    const [id, consumer, idleTime, deliveryCount] = item as [unknown, unknown, unknown, unknown];
    if (typeof id !== 'string' || typeof consumer !== 'string') {
      continue;
    }
    entries.push({
      id,
      consumer,
      idleTime: Number(idleTime) || 0,
      deliveryCount: Number(deliveryCount) || 0,
    });
  }
  return entries;
}

/**
 * Claim specific pending message IDs and return their job bodies.
 * Uses XCLAIM. Call this only for messages whose owning consumer is confirmed dead.
 *
 * @param ids - Message IDs to claim (from listPendingStepJobs)
 */
export async function claimPendingStepJobsByIds(
  redis: Redis,
  stepType: StepType,
  consumerName: string,
  ids: string[],
  options?: {
    streamKey?: string;
    consumerGroup?: string;
  },
): Promise<Array<{ id: string; job: StepJobMessage }>> {
  if (ids.length === 0) {
    return [];
  }

  const streamKey = options?.streamKey ?? StreamKeys.jobStream(stepType);
  const groupName = options?.consumerGroup ?? ConsumerGroups.executor(stepType);

  // XCLAIM key group consumer min-idle id [id ...]
  // min-idle=0 since we've already filtered by idle time
  const result = await redis.xclaim(streamKey, groupName, consumerName, 0, ...ids);

  if (!Array.isArray(result)) {
    return [];
  }

  const jobs: Array<{ id: string; job: StepJobMessage }> = [];

  for (const entry of result) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }

    const [id, fields] = entry as [unknown, unknown];
    if (!Array.isArray(fields)) {
      continue;
    }

    const fieldObj: Record<string, string> = {};
    const fieldsArr = fields as string[];
    for (let i = 0; i < fieldsArr.length; i += 2) {
      const key = fieldsArr[i];
      const value = fieldsArr[i + 1];
      if (key !== undefined && value !== undefined) {
        fieldObj[key] = value;
      }
    }

    const message = deserializeMessage(fieldObj);
    const parseResult = StepJobMessageSchema.safeParse(message);
    const idStr = id as string;

    if (parseResult.success) {
      jobs.push({ id: idStr, job: parseResult.data });
    } else {
      console.warn(
        `Invalid claimed job message ${idStr} in stream ${streamKey}:`,
        parseResult.error.message,
      );
    }
  }

  return jobs;
}

export async function claimPendingStepJobs(
  redis: Redis,
  stepType: StepType,
  consumerName: string,
  options: {
    /** Minimum idle time in ms before claiming (default: 60000 = 1 minute) */
    minIdleMs?: number;
    /** Maximum messages to claim (default: 10) */
    count?: number;
    /** Override stream key */
    streamKey?: string;
    /** Override consumer group */
    consumerGroup?: string;
  } = {},
): Promise<Array<{ id: string; job: StepJobMessage }>> {
  const streamKey = options.streamKey ?? StreamKeys.jobStream(stepType);
  const groupName = options.consumerGroup ?? ConsumerGroups.executor(stepType);
  const minIdleMs = options.minIdleMs ?? 60_000;
  const count = options.count ?? 10;

  // XAUTOCLAIM returns: [nextStartId, [[id, [field, value, ...]], ...], [deletedIds]]
  const result = await redis.xautoclaim(
    streamKey,
    groupName,
    consumerName,
    minIdleMs,
    '0-0',
    'COUNT',
    count,
  );

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- ioredis may return null
  if (!result || !Array.isArray(result) || result.length < 2) {
    return [];
  }

  const entries = result[1] as Array<[string, string[]]>;
  if (!Array.isArray(entries)) {
    return [];
  }

  const jobs: Array<{ id: string; job: StepJobMessage }> = [];

  for (const [id, fields] of entries) {
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
    const parseResult = StepJobMessageSchema.safeParse(message);

    if (parseResult.success) {
      jobs.push({ id, job: parseResult.data });
    } else {
      console.warn(
        `Invalid claimed job message ${id} in stream ${streamKey}:`,
        parseResult.error.message,
      );
    }
  }

  return jobs;
}
