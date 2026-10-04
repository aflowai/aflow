/**
 * Active-run membership, against a real Redis.
 *
 * The point of moving off increment/decrement counters is that terminal
 * transitions arrive from several places — applyResult, cancelRun,
 * forceCompleteInFlightStep, pause routing — and a redelivery can run any of
 * them twice. A counter drifts permanently when that happens; membership does
 * not. That property is the whole reason for the change, so it is asserted.
 *
 * The Lua touches two keys at once, which ioredis-mock does not reproduce.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { stackRedis } from '../testing/stackRedis.js';
import { StreamKeys } from '@aflow/schemas';
import {
  getActiveShardIds,
  getShardActiveRuns,
  getSystemLoad,
  markRunActive,
  markRunInactive,
} from '../shard.js';
import { shardFor } from '../shard.js';

/**
 * Isolated to a dedicated Redis database. These suites write shard-registry,
 * liveness and stream-group state under the same fixed key names production
 * uses, so on db 0 they would fight a dev orchestrator for ownership — and take
 * shards away from it mid-run.
 */
const TEST_DB = 15;

const STACK_REDIS = await stackRedis(TEST_DB);

const TENANT = 'a0000000-0000-0000-0000-0000000180cc';

const RUNS = [
  '90000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000002',
  '90000000-0000-0000-0000-000000000003',
];

describe.skipIf(!STACK_REDIS.available)('active-run membership', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = new Redis(STACK_REDIS.url, { maxRetriesPerRequest: 1 });
    // The global set is shared, so clear only the ids this suite owns.
    await redis.srem(StreamKeys.activeRunsKey, ...RUNS.map((r) => `${TENANT}:${r}`));
    for (const runId of RUNS) {
      await redis.srem(StreamKeys.shardActiveRunsKey(shardFor(runId)), `${TENANT}:${runId}`);
    }
  });

  afterEach(async () => {
    await redis.srem(StreamKeys.activeRunsKey, ...RUNS.map((r) => `${TENANT}:${r}`));
    for (const runId of RUNS) {
      await redis.srem(StreamKeys.shardActiveRunsKey(shardFor(runId)), `${TENANT}:${runId}`);
      if ((await redis.scard(StreamKeys.shardActiveRunsKey(shardFor(runId)))) === 0) {
        await redis.srem(StreamKeys.activeShardsKey, String(shardFor(runId)));
      }
    }
    redis.disconnect();
  });

  it('counts a run once no matter how often its start is delivered', async () => {
    const before = (await getSystemLoad(redis)).totalActiveRuns;
    await markRunActive(redis, TENANT, RUNS[0]!);
    await markRunActive(redis, TENANT, RUNS[0]!);
    await markRunActive(redis, TENANT, RUNS[0]!);
    expect((await getSystemLoad(redis)).totalActiveRuns).toBe(before + 1);
  });

  it('does not go negative when a terminal transition is delivered twice', async () => {
    const before = (await getSystemLoad(redis)).totalActiveRuns;
    await markRunActive(redis, TENANT, RUNS[0]!);
    await markRunInactive(redis, TENANT, RUNS[0]!);
    await markRunInactive(redis, TENANT, RUNS[0]!);
    await markRunInactive(redis, TENANT, RUNS[0]!);
    expect((await getSystemLoad(redis)).totalActiveRuns).toBe(before);
  });

  it('tracks the shard set and the fleet set together', async () => {
    const runId = RUNS[1]!;
    const shardId = shardFor(runId);
    const shardBefore = await getShardActiveRuns(redis, shardId);

    await markRunActive(redis, TENANT, runId);
    expect(await getShardActiveRuns(redis, shardId)).toBe(shardBefore + 1);
    expect(await redis.sismember(StreamKeys.activeRunsKey, `${TENANT}:${runId}`)).toBe(1);

    await markRunInactive(redis, TENANT, runId);
    expect(await getShardActiveRuns(redis, shardId)).toBe(shardBefore);
    expect(await redis.sismember(StreamKeys.activeRunsKey, `${TENANT}:${runId}`)).toBe(0);
  });

  it('tracks which shards hold active runs, and forgets them when they empty', async () => {
    // Recovery work that only matters where work exists reads this instead of
    // walking every configured shard, so an entry that outlives its runs would
    // put that cost back.
    const runId = RUNS[2]!;
    const shardId = shardFor(runId);

    await markRunActive(redis, TENANT, runId);
    expect(await getActiveShardIds(redis)).toContain(shardId);

    await markRunInactive(redis, TENANT, runId);
    const remainingOnShard = await getShardActiveRuns(redis, shardId);
    if (remainingOnShard === 0) {
      expect(await getActiveShardIds(redis)).not.toContain(shardId);
    }
  });

  it('reads the fleet count in one command regardless of shard count', async () => {
    // Counted on the client: a server-wide counter would also see the other
    // test files sharing this Redis.
    const scard = vi.spyOn(redis, 'scard');
    const get = vi.spyOn(redis, 'get');
    try {
      await getSystemLoad(redis);
      expect(scard).toHaveBeenCalledTimes(1);
      expect(get).not.toHaveBeenCalled();
    } finally {
      scard.mockRestore();
      get.mockRestore();
    }
  });
});
