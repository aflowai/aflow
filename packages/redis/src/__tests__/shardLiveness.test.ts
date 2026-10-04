/**
 * Shard ownership against instance liveness, on a real Redis.
 *
 * The design this replaces conflated two facts in one per-shard key: who owns a
 * shard, and whether a process is alive. Renewal never checked ownership and
 * acquisition only checked that *some* marker existed, so an instance that had
 * lost a shard could keep that shard's marker warm indefinitely and make it
 * unacquirable while its registered owner was dead.
 *
 * Every case below is one of the ways that conflation broke, so they are
 * asserted rather than argued.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { stackRedis } from '../testing/stackRedis.js';
import { StreamKeys } from '@aflow/schemas';
import {
  acquireAvailableShards,
  acquireShard,
  clearLegacyShardHeartbeats,
  getShardOwnerMap,
  releaseShards,
  renewLegacyShardHeartbeats,
  validateShardOwnership,
} from '../shard.js';
import {
  isOrchestratorAlive,
  registerOrchestratorHeartbeat,
  unregisterOrchestratorHeartbeat,
} from '../streams/orchestratorHeartbeat.js';

/**
 * Isolated to a dedicated Redis database. These suites write shard-registry,
 * liveness and stream-group state under the same fixed key names production
 * uses, so on db 0 they would fight a dev orchestrator for ownership — and take
 * shards away from it mid-run.
 */
const TEST_DB = 15;

const STACK_REDIS = await stackRedis(TEST_DB);

const A = 'instance-A-liveness-test';
const B = 'instance-B-liveness-test';
const C = 'instance-C-liveness-test';
const SHARD = 91;
const OTHER_SHARD = 92;

describe.skipIf(!STACK_REDIS.available)('shard ownership and instance liveness', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = new Redis(STACK_REDIS.url, { maxRetriesPerRequest: 1 });
    await redis.hdel(StreamKeys.shardRegistryKey, `shard:${SHARD}`, `shard:${OTHER_SHARD}`);
    await redis.zrem(StreamKeys.orchestratorLivenessKey, A, B, C);
  });

  afterEach(async () => {
    await redis.hdel(StreamKeys.shardRegistryKey, `shard:${SHARD}`, `shard:${OTHER_SHARD}`);
    await redis.zrem(StreamKeys.orchestratorLivenessKey, A, B, C);
    await clearLegacyShardHeartbeats(redis, [SHARD, OTHER_SHARD]);
    redis.disconnect();
  });

  it('refuses a shard whose registered owner is alive', async () => {
    await registerOrchestratorHeartbeat(redis, A);
    expect(await acquireShard(redis, SHARD, A)).toBeGreaterThan(0);

    await registerOrchestratorHeartbeat(redis, B);
    expect(await acquireShard(redis, SHARD, B)).toBe(-1);
  });

  it('lets a stale instance keep itself alive without keeping a lost shard busy', async () => {
    // A owns the shard, then stops beating; B takes it.
    await registerOrchestratorHeartbeat(redis, A);
    await acquireShard(redis, SHARD, A);
    await unregisterOrchestratorHeartbeat(redis, A);

    await registerOrchestratorHeartbeat(redis, B);
    expect(await acquireShard(redis, SHARD, B)).toBeGreaterThan(0);

    // A comes back and beats again — but it is no longer the registered owner.
    await registerOrchestratorHeartbeat(redis, A);

    // B dies. The shard must become available even though A is alive and, under
    // the old design, would have been refreshing this shard's marker.
    await unregisterOrchestratorHeartbeat(redis, B);
    expect(await acquireShard(redis, SHARD, C)).toBeGreaterThan(0);
  });

  it("does not let a stale instance's liveness mask the registered owner's death", async () => {
    await registerOrchestratorHeartbeat(redis, A);
    await acquireShard(redis, SHARD, A);
    await registerOrchestratorHeartbeat(redis, B);
    await unregisterOrchestratorHeartbeat(redis, A);

    // A is gone; B is alive but owns nothing here. The shard is free.
    expect(await isOrchestratorAlive(redis)).toBe(true);
    expect(await acquireShard(redis, SHARD, B)).toBeGreaterThan(0);
  });

  it("releases one shard without releasing the instance's others", async () => {
    await registerOrchestratorHeartbeat(redis, A);
    const fenceOne = await acquireShard(redis, SHARD, A);
    const fenceTwo = await acquireShard(redis, OTHER_SHARD, A);

    await releaseShards(redis, A, [SHARD], new Map([[SHARD, fenceOne]]));

    // The released shard is free; the other is untouched and still A's.
    await registerOrchestratorHeartbeat(redis, B);
    expect(await acquireShard(redis, SHARD, B)).toBeGreaterThan(0);
    expect(await acquireShard(redis, OTHER_SHARD, B)).toBe(-1);
    expect(await validateShardOwnership(redis, OTHER_SHARD, A, fenceTwo)).toBe(true);
  });

  it('keeps the fleet alive when one instance shuts down', async () => {
    await registerOrchestratorHeartbeat(redis, A);
    await registerOrchestratorHeartbeat(redis, B);

    await unregisterOrchestratorHeartbeat(redis, A);

    // The previous shared key meant A's shutdown reported every orchestrator
    // offline, and the server watchdog then stalled healthy queued work.
    expect(await isOrchestratorAlive(redis)).toBe(true);
  });

  it('cannot revoke a successor when a late release lands', async () => {
    await registerOrchestratorHeartbeat(redis, A);
    const staleFence = await acquireShard(redis, SHARD, A);

    await unregisterOrchestratorHeartbeat(redis, A);
    await registerOrchestratorHeartbeat(redis, B);
    const successorFence = await acquireShard(redis, SHARD, B);
    expect(successorFence).toBeGreaterThan(staleFence);

    // A's shutdown release arrives after B took over.
    await releaseShards(redis, A, [SHARD], new Map([[SHARD, staleFence]]));

    const owners = await getShardOwnerMap(redis);
    expect(owners.get(SHARD)?.owner).toBe(B);
    expect(owners.get(SHARD)?.released).not.toBe(true);
    expect(await validateShardOwnership(redis, SHARD, B, successorFence)).toBe(true);
  });

  it('will not take a shard from an owner still running the per-shard protocol', async () => {
    // A process on the previous release is absent from the liveness index while
    // perfectly alive. Without the compatibility read, the first instance to
    // deploy would treat the entire old fleet as dead and take every shard it
    // holds, mid-flight.
    await registerOrchestratorHeartbeat(redis, A);
    await acquireShard(redis, SHARD, A);
    await unregisterOrchestratorHeartbeat(redis, A);

    // A keeps only its per-shard marker warm, as the old code does.
    await renewLegacyShardHeartbeats(redis, A, [SHARD]);

    await registerOrchestratorHeartbeat(redis, B);
    expect(await acquireShard(redis, SHARD, B)).toBe(-1);

    // Once that marker lapses too, the shard is genuinely free.
    await clearLegacyShardHeartbeats(redis, [SHARD]);
    expect(await acquireShard(redis, SHARD, B)).toBeGreaterThan(0);
  });

  it('re-acquiring a shard it already holds does not move the fencing token', async () => {
    // The reacquisition tick re-runs acquire for shards already held. Bumping
    // the token there invalidates the one the process is actively writing under,
    // which rejects its own in-flight work.
    await registerOrchestratorHeartbeat(redis, A);
    const first = await acquireShard(redis, SHARD, A);
    const second = await acquireShard(redis, SHARD, A);
    expect(second).toBe(first);
    expect(await validateShardOwnership(redis, SHARD, A, first)).toBe(true);
  });

  it('reaches a revoked shard instead of spending its slot on one it already holds', async () => {
    // acquireAvailableShards scans from shard 0 upward. Without skipping held
    // shards, an instance with one free slot re-takes shard 0 every tick and
    // never reaches the shard it lost — which then never serves its sessions.
    await registerOrchestratorHeartbeat(redis, A);
    const held = await acquireShard(redis, 0, A);
    expect(held).toBeGreaterThan(0);

    const acquired = await acquireAvailableShards(redis, A, 1, new Set([0]));
    expect(acquired.map((entry) => entry.shardId)).not.toContain(0);
    expect(acquired).toHaveLength(1);

    await releaseShards(
      redis,
      A,
      [0, ...acquired.map((e) => e.shardId)],
      new Map([[0, held], ...acquired.map((e) => [e.shardId, e.fencingToken] as const)]),
    );
  });

  it('keeps the liveness set bounded by pruning expired members', async () => {
    // An expiry already in the past stands in for an instance that stopped
    // beating; the next heartbeat from anyone should evict it.
    await redis.zadd(StreamKeys.orchestratorLivenessKey, Date.now() - 60_000, C);
    await registerOrchestratorHeartbeat(redis, A);

    expect(await redis.zscore(StreamKeys.orchestratorLivenessKey, C)).toBeNull();
    expect(await redis.zscore(StreamKeys.orchestratorLivenessKey, A)).not.toBeNull();
  });
});
