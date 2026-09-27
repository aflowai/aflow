/**
 * Hot-path guard for the blocking shard-stream reads.
 *
 * Raising `blockMs` cuts the cost of an *empty* read, and is only safe because
 * Redis wakes a blocked `XREADGROUP` the instant a matching entry is added — a
 * result arriving 5 ms into a 2 s block is delivered at 5 ms, not at 2 s. That
 * is the whole basis for the change, so it is asserted rather than assumed: if
 * it ever stopped holding, every step result in a running session would be
 * delayed by up to `blockMs`.
 *
 * Needs a real Redis; ioredis-mock does not implement blocking reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { ConsumerGroups, StreamKeys } from '@aflow/schemas';
import { buildResultStreamSet, readShardStepResults } from '../streams/shardReads.js';
import { SHARD_COUNT } from '../shard.js';

/**
 * Isolated to a dedicated Redis database. These suites write shard-registry,
 * liveness and stream-group state under the same fixed key names production
 * uses, so on db 0 they would fight a dev orchestrator for ownership — and take
 * shards away from it mid-run.
 */
const TEST_DB = 15;

async function redisReachable(): Promise<boolean> {
  const probe = new Redis({
    host: '127.0.0.1',
    port: 6379,
    db: TEST_DB,
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const AVAILABLE = await redisReachable();

/** A block long enough that a naive implementation would obviously fail the assertion. */
const LONG_BLOCK_MS = 4000;
/** Delivery must be immediate; this leaves room for scheduling on a loaded machine. */
const MAX_DELIVERY_MS = 750;

const ALL_SHARDS = Array.from({ length: SHARD_COUNT }, (_, i) => i);
const TARGET_SHARD = 77;

describe.skipIf(!AVAILABLE)('blocking shard reads wake on arrival, not on timeout', () => {
  let reader: RedisType;
  let writer: RedisType;

  beforeEach(async () => {
    reader = new Redis({ host: '127.0.0.1', port: 6379, db: TEST_DB, maxRetriesPerRequest: 1 });
    writer = new Redis({ host: '127.0.0.1', port: 6379, db: TEST_DB, maxRetriesPerRequest: 1 });
    for (const shardId of ALL_SHARDS) {
      await writer
        .xgroup(
          'CREATE',
          StreamKeys.shardResultsStream(shardId),
          ConsumerGroups.orchestrator,
          '$',
          'MKSTREAM',
        )
        .catch(() => undefined);
    }
  });

  afterEach(async () => {
    await writer.del(StreamKeys.shardResultsStream(TARGET_SHARD)).catch(() => undefined);
    reader.disconnect();
    writer.disconnect();
  });

  it('delivers an entry that arrives mid-block without waiting out the block', async () => {
    const streams = buildResultStreamSet(ALL_SHARDS);

    const startedAt = Date.now();
    const readPromise = readShardStepResults(reader as never, 'latency-probe', streams, {
      count: 10,
      blockMs: LONG_BLOCK_MS,
    });

    // Land an entry well inside the block window.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writer.xadd(
      StreamKeys.shardResultsStream(TARGET_SHARD),
      '*',
      'messageVersion',
      '1',
      'tenantId',
      'not-a-valid-result',
    );

    await readPromise;
    const elapsed = Date.now() - startedAt;

    // The payload is deliberately unparseable — this asserts wake latency, not
    // deserialization. What matters is that the read returned long before the
    // block would have expired.
    expect(elapsed).toBeLessThan(MAX_DELIVERY_MS);
    expect(elapsed).toBeLessThan(LONG_BLOCK_MS / 2);
  });

  it('recreates a consumer group that vanished under a running consumer', async () => {
    // Groups are otherwise only created at boot. Without repair, a stream lost to
    // eviction, a Redis restart, or a failover leaves the consumer logging
    // NOGROUP on every read while that shard's results are never processed.
    const streams = buildResultStreamSet(ALL_SHARDS);

    // Destroy the stream and its group, exactly as losing the key would.
    await writer.del(StreamKeys.shardResultsStream(TARGET_SHARD));

    const results = await readShardStepResults(reader as never, 'repair-probe', streams, {
      count: 10,
      blockMs: 200,
    });
    expect(results).toEqual([]);

    // The group is back, so the consumer keeps working rather than spinning.
    const groups = (await writer.xinfo(
      'GROUPS',
      StreamKeys.shardResultsStream(TARGET_SHARD),
    )) as unknown[];
    expect(groups.length).toBeGreaterThan(0);
  });

  it('returns empty only after the full block when nothing arrives', async () => {
    const streams = buildResultStreamSet(ALL_SHARDS);
    const startedAt = Date.now();
    const results = await readShardStepResults(reader as never, 'latency-probe', streams, {
      count: 10,
      blockMs: 500,
    });
    const elapsed = Date.now() - startedAt;

    expect(results).toEqual([]);
    // Confirms the block is real: without it this would spin and return at once.
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });
});
