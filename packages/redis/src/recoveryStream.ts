import type { Redis, ChainableCommander } from 'ioredis';
import {
  RecoveryEventEnvelopeSchema,
  RecoveryStreamKeys,
  type RecoveryEventEnvelope,
  type RecoveryEventType,
} from '@aflow/schemas';
import { HOT_STATE_TTL_SECONDS } from './hotState.js';

// ============================================================================
// Seq Allocation
// ============================================================================

/**
 * Allocate the next monotonic sequence number for a run's recovery events.
 * Uses Redis INCR — guaranteed monotonic within a run.
 */
export async function allocateRecoverySeq(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<number> {
  const key = RecoveryStreamKeys.recoverySeqKey(tenantId, runId);
  const seq = await redis.incr(key);
  // Set TTL if this is the first allocation (key was just created)
  if (seq === 1) {
    await redis.expire(key, HOT_STATE_TTL_SECONDS);
  }
  return seq;
}

/**
 * Batch-allocate N sequential seq numbers for a single run.
 * Uses INCRBY — one round-trip for N seqs.
 * Returns an array of seqs [first, first+1, ..., first+N-1].
 */
export async function allocateRecoverySeqBatch(
  redis: Redis,
  tenantId: string,
  runId: string,
  count: number,
): Promise<number[]> {
  if (count <= 0) return [];
  const key = RecoveryStreamKeys.recoverySeqKey(tenantId, runId);
  const lastSeq = await redis.incrby(key, count);
  // Extend TTL
  await redis.expire(key, HOT_STATE_TTL_SECONDS);
  const firstSeq = lastSeq - count + 1;
  return Array.from({ length: count }, (_, i) => firstSeq + i);
}

// ============================================================================
// Recovery Event Construction
// ============================================================================

/**
 * Build a RecoveryEventEnvelope with pre-allocated seq.
 */
export function buildRecoveryEvent(
  seq: number,
  tenantId: string,
  runId: string,
  type: RecoveryEventType,
  data: Record<string, unknown>,
  stepExecutionId?: string,
): RecoveryEventEnvelope {
  return {
    version: 1,
    type,
    tenantId,
    runId,
    seq,
    timestamp: Date.now(),
    ...(stepExecutionId !== undefined ? { stepExecutionId } : {}),
    data,
  };
}

// ============================================================================
// Stream Writing
// ============================================================================

/**
 * Serialize a recovery event for Redis stream storage.
 * Returns flat [key, value, key, value, ...] array.
 */
function serializeRecoveryEvent(event: RecoveryEventEnvelope): string[] {
  const fields: string[] = [];
  fields.push('version', String(event.version));
  fields.push('type', event.type);
  fields.push('tenantId', event.tenantId);
  fields.push('runId', event.runId);
  fields.push('seq', String(event.seq));
  fields.push('timestamp', String(event.timestamp));
  if (event.stepExecutionId !== undefined) {
    fields.push('stepExecutionId', event.stepExecutionId);
  }
  fields.push('data', JSON.stringify(event.data));
  return fields;
}

/**
 * Append a recovery event to the per-run recovery stream (standalone).
 * Allocates seq automatically.
 */
export async function appendRecoveryEvent(
  redis: Redis,
  tenantId: string,
  runId: string,
  type: RecoveryEventType,
  data: Record<string, unknown>,
  stepExecutionId?: string,
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): Promise<{ seq: number; streamId: string }> {
  const seq = await allocateRecoverySeq(redis, tenantId, runId);
  const event = buildRecoveryEvent(seq, tenantId, runId, type, data, stepExecutionId);
  const streamKey = RecoveryStreamKeys.recoveryStream(tenantId, runId);
  const fields = serializeRecoveryEvent(event);

  // No MAXLEN trim — recovery events are trimmed based on snapshot seq, not count
  const streamId = await redis.xadd(streamKey, '*', ...fields);
  await redis.expire(streamKey, ttlSeconds);

  if (!streamId) {
    throw new Error(`Failed to append recovery event to ${streamKey}`);
  }

  // Increment event count (for snapshot trigger)
  await redis.incr(RecoveryStreamKeys.recoveryEventCountKey(tenantId, runId));

  return { seq, streamId };
}

/**
 * Append recovery event(s) to an existing pipeline (for atomic operations).
 * Seq must be pre-allocated via allocateRecoverySeqBatch.
 */
export function appendRecoveryEventsToPipeline(
  pipeline: ChainableCommander,
  tenantId: string,
  runId: string,
  events: RecoveryEventEnvelope[],
  ttlSeconds: number = HOT_STATE_TTL_SECONDS,
): void {
  if (events.length === 0) return;

  const streamKey = RecoveryStreamKeys.recoveryStream(tenantId, runId);
  for (const event of events) {
    const fields = serializeRecoveryEvent(event);
    pipeline.xadd(streamKey, '*', ...fields);
  }
  pipeline.expire(streamKey, ttlSeconds);

  // Increment event count for snapshot trigger
  const countKey = RecoveryStreamKeys.recoveryEventCountKey(tenantId, runId);
  pipeline.incrby(countKey, events.length);
  pipeline.expire(countKey, ttlSeconds);
}

// ============================================================================
// Stream Reading
// ============================================================================

/**
 * Read recovery events from a run's recovery stream.
 * Optionally filter to events after a given seq (for tail replay after snapshot).
 */
export async function readRecoveryEvents(
  redis: Redis,
  tenantId: string,
  runId: string,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<RecoveryEventEnvelope[]> {
  const streamKey = RecoveryStreamKeys.recoveryStream(tenantId, runId);
  const limit = options.limit ?? 10000;

  // Read all events from stream
  const result = await redis.xrange(streamKey, '-', '+', 'COUNT', limit);
  if (!result || result.length === 0) return [];

  const events: RecoveryEventEnvelope[] = [];
  const afterSeq = options.afterSeq ?? -1;

  for (const [, fields] of result) {
    // Parse fields from flat array to object
    const fieldObj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];
      if (key !== undefined && value !== undefined) {
        fieldObj[key] = value;
      }
    }

    // Parse the event
    const raw: Record<string, unknown> = {
      version: parseInt(fieldObj['version'] ?? '1', 10),
      type: fieldObj['type'],
      tenantId: fieldObj['tenantId'],
      runId: fieldObj['runId'],
      seq: parseInt(fieldObj['seq'] ?? '0', 10),
      timestamp: parseInt(fieldObj['timestamp'] ?? '0', 10),
      data: {},
    };
    if (fieldObj['stepExecutionId']) {
      raw['stepExecutionId'] = fieldObj['stepExecutionId'];
    }
    if (fieldObj['data']) {
      try {
        raw['data'] = JSON.parse(fieldObj['data']);
      } catch {
        raw['data'] = {};
      }
    }

    // Filter by seq
    const seq = raw['seq'] as number;
    if (seq <= afterSeq) continue;

    const parseResult = RecoveryEventEnvelopeSchema.safeParse(raw);
    if (parseResult.success) {
      events.push(parseResult.data);
    }
  }

  // Sort by seq for deterministic replay order
  events.sort((a, b) => a.seq - b.seq);
  return events;
}

/**
 * Get the current recovery event count since last snapshot.
 * Used by snapshot trigger logic.
 */
export async function getRecoveryEventCount(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<number> {
  const key = RecoveryStreamKeys.recoveryEventCountKey(tenantId, runId);
  const val = await redis.get(key);
  return val ? parseInt(val, 10) : 0;
}

/**
 * Reset recovery event count (called after taking a snapshot).
 */
export async function resetRecoveryEventCount(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<void> {
  const key = RecoveryStreamKeys.recoveryEventCountKey(tenantId, runId);
  await redis.del(key);
}

/**
 * Trim recovery events older than a given stream ID.
 * Called after a snapshot is taken to bound stream size.
 */
export async function trimRecoveryStream(
  redis: Redis,
  tenantId: string,
  runId: string,
  minId: string,
): Promise<number> {
  const streamKey = RecoveryStreamKeys.recoveryStream(tenantId, runId);
  // XTRIM with MINID removes entries with IDs lower than minId
  return redis.xtrim(streamKey, 'MINID', minId);
}

/**
 * Delete recovery stream and seq counter for a run.
 * Called when a run is fully terminal and flushed to Postgres.
 */
export async function deleteRecoveryData(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<void> {
  const streamKey = RecoveryStreamKeys.recoveryStream(tenantId, runId);
  const seqKey = RecoveryStreamKeys.recoverySeqKey(tenantId, runId);
  const countKey = RecoveryStreamKeys.recoveryEventCountKey(tenantId, runId);
  const snapshotKey = RecoveryStreamKeys.snapshotRefKey(tenantId, runId);
  await redis.del(streamKey, seqKey, countKey, snapshotKey);
}
