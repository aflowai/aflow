import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import {
  upsertPendingDelegationCompletion,
  claimDuePendingDelegations,
  releasePendingDelegation,
  completeDelegationLifecycle,
  abortDelegationLifecycle,
  getPendingDelegationData,
  getDelegationParent,
  getPendingDelegationCount,
} from '../delegationPending.js';

const TENANT = 'tenant-pending-test';
const PARENT = '11111111-1111-4111-9111-111111111111';
const PARENT_STEP = '22222222-2222-4222-9222-222222222222';
const CHILD = '33333333-3333-4333-9333-333333333333';
const CHILD_B = '44444444-4444-4444-9444-444444444444';

function mkRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

async function seedReverseIndex(
  redis: RedisType,
  tenantId: string,
  childRunId: string,
  parentRunId: string,
  parentStepExecutionId: string,
): Promise<void> {
  await redis.hset(StreamKeys.delegationParentKey(tenantId, childRunId), {
    parentRunId,
    parentStepExecutionId,
  });
}

describe('upsertPendingDelegationCompletion', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall(); // ioredis-mock shares state across instances by default
  });

  it('inserts a new entry on first call; data hash carries parent ids redundantly', async () => {
    const due = 1_000_000;
    const inserted = await upsertPendingDelegationCompletion(
      redis,
      TENANT,
      CHILD,
      PARENT,
      PARENT_STEP,
      due,
    );
    expect(inserted).toBe(true);

    const score = await redis.zscore(StreamKeys.delegationPendingKey, `${TENANT}:${CHILD}`);
    expect(Number(score)).toBe(due);

    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data).not.toBeNull();
    expect(data?.parentRunId).toBe(PARENT);
    expect(data?.parentStepExecutionId).toBe(PARENT_STEP);
    expect(data?.attempt).toBe(0);
  });

  it('idempotent: a second upsert at a later score does NOT reset the schedule (ZADD NX)', async () => {
    const firstDue = 1_000_000;
    const secondDue = 5_000_000;
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, firstDue);
    const inserted = await upsertPendingDelegationCompletion(
      redis,
      TENANT,
      CHILD,
      PARENT,
      PARENT_STEP,
      secondDue,
    );
    expect(inserted).toBe(false);
    const score = await redis.zscore(StreamKeys.delegationPendingKey, `${TENANT}:${CHILD}`);
    expect(Number(score)).toBe(firstDue);
  });

  it('overwrites parent ids on re-upsert (re-parenting via agent.control.resume)', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 1_000_000);
    const NEW_PARENT_STEP = '55555555-5555-4555-9555-555555555555';
    await upsertPendingDelegationCompletion(
      redis,
      TENANT,
      CHILD,
      PARENT,
      NEW_PARENT_STEP,
      5_000_000,
    );
    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data?.parentStepExecutionId).toBe(NEW_PARENT_STEP);
  });
});

describe('claimDuePendingDelegations', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
  });

  it('claims due entries (score <= now) and bumps score by leaseMs', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    const claimed = await claimDuePendingDelegations(redis, 'worker-1', 30_000, 10, 1000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.tenantId).toBe(TENANT);
    expect(claimed[0]?.childRunId).toBe(CHILD);
    expect(claimed[0]?.data.parentRunId).toBe(PARENT);
    expect(claimed[0]?.data.parentStepExecutionId).toBe(PARENT_STEP);
    expect(claimed[0]?.data.claimedBy).toBe('worker-1');

    const score = await redis.zscore(StreamKeys.delegationPendingKey, `${TENANT}:${CHILD}`);
    expect(Number(score)).toBe(1000 + 30_000);
  });

  it('does NOT claim entries whose score is in the future (still leased)', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    await claimDuePendingDelegations(redis, 'worker-1', 30_000, 10, 1000);
    // worker-2 tries to claim 5s later; entry is still leased
    const claimedAgain = await claimDuePendingDelegations(redis, 'worker-2', 30_000, 10, 6000);
    expect(claimedAgain).toHaveLength(0);
  });

  it('reclaims entries after lease expires (same code path; no separate sweep needed)', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    await claimDuePendingDelegations(redis, 'worker-1', 30_000, 10, 1000);
    // worker-1 crashes; worker-2 picks it up after lease expires.
    const reclaim = await claimDuePendingDelegations(redis, 'worker-2', 30_000, 10, 50_000);
    expect(reclaim).toHaveLength(1);
    expect(reclaim[0]?.data.claimedBy).toBe('worker-2');
  });

  it('respects batch limit', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD_B, PARENT, PARENT_STEP, 100);
    const claimed = await claimDuePendingDelegations(redis, 'worker-1', 30_000, 1, 1000);
    expect(claimed).toHaveLength(1);
    // ZSET still has 2 members; the second is unclaimed.
    expect(await redis.zcard(StreamKeys.delegationPendingKey)).toBe(2);
  });

  it('surfaces entry even when data hash is wiped (parentRunId empty); drain decides recovery path', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    // Simulate eviction of the data hash but ZSET entry remains.
    await redis.del(StreamKeys.delegationPendingDataKey(TENANT, CHILD));
    const claimed = await claimDuePendingDelegations(redis, 'worker-1', 30_000, 10, 1000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.data.parentRunId).toBe('');
    expect(claimed[0]?.data.parentStepExecutionId).toBe('');
  });
});

describe('releasePendingDelegation', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
  });

  it('reschedules the entry, bumps attempt, clears claim stamps', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    await claimDuePendingDelegations(redis, 'worker-1', 30_000, 10, 1000);

    const ok = await releasePendingDelegation(redis, TENANT, CHILD, 6000, 1, 'transient hiccup');
    expect(ok).toBe(true);

    const score = await redis.zscore(StreamKeys.delegationPendingKey, `${TENANT}:${CHILD}`);
    expect(Number(score)).toBe(6000);

    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data?.attempt).toBe(1);
    expect(data?.lastError).toBe('transient hiccup');
    expect(data?.claimedBy).toBeUndefined();
    expect(data?.claimedAt).toBeUndefined();
  });

  it('returns false for an entry that was already cleaned up', async () => {
    const ok = await releasePendingDelegation(redis, TENANT, CHILD, 6000, 1);
    expect(ok).toBe(false);
  });

  it('clears lastError when called without one', async () => {
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    await releasePendingDelegation(redis, TENANT, CHILD, 6000, 1, 'first error');
    await releasePendingDelegation(redis, TENANT, CHILD, 12_000, 2);
    const data = await getPendingDelegationData(redis, TENANT, CHILD);
    expect(data?.lastError).toBeUndefined();
    expect(data?.attempt).toBe(2);
  });
});

describe('completeDelegationLifecycle / abortDelegationLifecycle', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
    // Seed reverse index directly + pending entry
    await seedReverseIndex(redis, TENANT, CHILD, PARENT, PARENT_STEP);
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
  });

  it('complete: tears down ZSET entry + data hash + reverse index atomically', async () => {
    const removed = await completeDelegationLifecycle(redis, TENANT, CHILD);
    expect(removed).toBe(true);

    expect(await redis.zscore(StreamKeys.delegationPendingKey, `${TENANT}:${CHILD}`)).toBeNull();
    expect(
      Object.keys(await redis.hgetall(StreamKeys.delegationPendingDataKey(TENANT, CHILD))),
    ).toHaveLength(0);
    expect(
      Object.keys(await redis.hgetall(StreamKeys.delegationParentKey(TENANT, CHILD))),
    ).toHaveLength(0);
  });

  it('abort: same Redis ops as complete (semantic distinction is for callers, not Redis)', async () => {
    const removed = await abortDelegationLifecycle(redis, TENANT, CHILD);
    expect(removed).toBe(true);
    expect(await redis.zscore(StreamKeys.delegationPendingKey, `${TENANT}:${CHILD}`)).toBeNull();
    expect(
      Object.keys(await redis.hgetall(StreamKeys.delegationParentKey(TENANT, CHILD))),
    ).toHaveLength(0);
  });

  it('idempotent: subsequent complete/abort returns false but does not throw', async () => {
    await completeDelegationLifecycle(redis, TENANT, CHILD);
    const second = await completeDelegationLifecycle(redis, TENANT, CHILD);
    expect(second).toBe(false);
  });
});

describe('getDelegationParent', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = mkRedis();
    await redis.flushall();
  });

  it('returns null when reverse index is missing', async () => {
    const rev = await getDelegationParent(redis, TENANT, CHILD);
    expect(rev).toBeNull();
  });

  it('returns parent ids when present', async () => {
    await seedReverseIndex(redis, TENANT, CHILD, PARENT, PARENT_STEP);
    const rev = await getDelegationParent(redis, TENANT, CHILD);
    expect(rev).toEqual({ parentRunId: PARENT, parentStepExecutionId: PARENT_STEP });
  });
});

describe('getPendingDelegationCount', () => {
  it('returns the global pending count', async () => {
    const redis = mkRedis();
    await redis.flushall();
    expect(await getPendingDelegationCount(redis)).toBe(0);
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD, PARENT, PARENT_STEP, 100);
    await upsertPendingDelegationCompletion(redis, TENANT, CHILD_B, PARENT, PARENT_STEP, 100);
    expect(await getPendingDelegationCount(redis)).toBe(2);
  });
});
