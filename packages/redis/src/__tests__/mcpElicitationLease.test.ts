import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  acquireMcpElicitationLease,
  refreshMcpElicitationLease,
  readMcpElicitationLease,
  releaseMcpElicitationLease,
  forceDeleteMcpElicitationLease,
} from '../mcpElicitationLease.js';
import {
  mcpElicitationCandidateMember,
  peekDueMcpElicitationLeaseCandidates,
} from '../mcpElicitationLeaseCandidates.js';
import { StreamKeys } from '@aflow/schemas';

async function indexedMembers(redis: RedisType): Promise<string[]> {
  return redis.zrange(StreamKeys.mcpElicitationLeaseCandidatesKey, 0, -1);
}

function createMockRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

const TENANT = '00000000-0000-0000-0000-000000000001';

function baseLease(overrides: Record<string, string> = {}): {
  elicitationId: string;
  executorInstanceId: string;
  stepExecutionId: string;
  tenantId: string;
  bindingId: string;
  serverId: string;
  sessionId?: string;
} {
  return {
    elicitationId: 'elic-1',
    executorInstanceId: 'exec-A',
    stepExecutionId: 'step-1',
    tenantId: TENANT,
    bindingId: 'kaggle-default',
    serverId: 'kaggle',
    sessionId: 'session-1',
    ...overrides,
  };
}

describe('acquireMcpElicitationLease', () => {
  let redis: RedisType;
  beforeEach(async () => {
    redis = createMockRedis();
    await redis.flushall();
  });

  it('writes lease fields + sets TTL on success', async () => {
    const result = await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 900_000 });
    expect(result).not.toBeNull();
    expect(result!.elicitationId).toBe('elic-1');
    expect(result!.executorInstanceId).toBe('exec-A');

    const key = StreamKeys.mcpElicitationLeaseKey('elic-1');
    const stored = await redis.hgetall(key);
    expect(stored['elicitationId']).toBe('elic-1');
    expect(stored['executorInstanceId']).toBe('exec-A');
    expect(stored['stepExecutionId']).toBe('step-1');

    const ttl = await redis.ttl(key);
    // TTL near 900s (ioredis-mock returns seconds remaining); allow ±2s.
    expect(ttl).toBeGreaterThan(895);
    expect(ttl).toBeLessThanOrEqual(900);
  });

  it('returns null on conflict — second acquire for same elicitationId fails', async () => {
    const first = await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 900_000 });
    expect(first).not.toBeNull();

    const second = await acquireMcpElicitationLease(
      redis,
      baseLease({ executorInstanceId: 'exec-B' }),
      { ttlMs: 900_000 },
    );
    expect(second).toBeNull();

    // First holder's fields untouched.
    const stored = await redis.hgetall(StreamKeys.mcpElicitationLeaseKey('elic-1'));
    expect(stored['executorInstanceId']).toBe('exec-A');
  });

  it('stamps ISO acquiredAt + leaseExpiresAt', async () => {
    const before = Date.now();
    const result = await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 60_000 });
    const after = Date.now();
    const acquired = new Date(result!.acquiredAt).getTime();
    const expires = new Date(result!.leaseExpiresAt).getTime();
    expect(acquired).toBeGreaterThanOrEqual(before);
    expect(acquired).toBeLessThanOrEqual(after);
    expect(expires - acquired).toBe(60_000);
  });

  it('omits sessionId from result when not provided (workflow-task dispatch)', async () => {
    const noSession = baseLease();
    delete noSession.sessionId;
    const result = await acquireMcpElicitationLease(redis, noSession, { ttlMs: 60_000 });
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBeUndefined();
  });
});

describe('refreshMcpElicitationLease', () => {
  let redis: RedisType;
  beforeEach(async () => {
    redis = createMockRedis();
    await redis.flushall();
  });

  it('refreshes TTL when the calling instance is the holder', async () => {
    await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 60_000 });
    // Sleep a millisecond so the new expiresAt is observably later.
    await new Promise((r) => setTimeout(r, 5));
    const ok = await refreshMcpElicitationLease(redis, 'elic-1', 'exec-A', 120_000);
    expect(ok).toBe(true);
    const ttl = await redis.ttl(StreamKeys.mcpElicitationLeaseKey('elic-1'));
    expect(ttl).toBeGreaterThan(115);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('refuses to refresh when a different instance holds the lease', async () => {
    await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 60_000 });
    const ok = await refreshMcpElicitationLease(redis, 'elic-1', 'exec-IMPOSTOR', 120_000);
    expect(ok).toBe(false);
    // TTL untouched.
    const ttl = await redis.ttl(StreamKeys.mcpElicitationLeaseKey('elic-1'));
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('returns false when the lease has been deleted', async () => {
    const ok = await refreshMcpElicitationLease(redis, 'elic-missing', 'exec-A', 60_000);
    expect(ok).toBe(false);
  });

  it('updates leaseExpiresAt field, not just the Redis TTL', async () => {
    await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 60_000 });
    await new Promise((r) => setTimeout(r, 5));
    await refreshMcpElicitationLease(redis, 'elic-1', 'exec-A', 600_000);
    const stored = await redis.hgetall(StreamKeys.mcpElicitationLeaseKey('elic-1'));
    const expires = new Date(stored['leaseExpiresAt']!).getTime();
    expect(expires - Date.now()).toBeGreaterThan(595_000);
  });
});

describe('readMcpElicitationLease', () => {
  let redis: RedisType;
  beforeEach(async () => {
    redis = createMockRedis();
    await redis.flushall();
  });

  it('returns the lease when present', async () => {
    await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 60_000 });
    const read = await readMcpElicitationLease(redis, 'elic-1');
    expect(read).not.toBeNull();
    expect(read!.executorInstanceId).toBe('exec-A');
    expect(read!.bindingId).toBe('kaggle-default');
  });

  it('returns null when the key does not exist', async () => {
    const read = await readMcpElicitationLease(redis, 'elic-missing');
    expect(read).toBeNull();
  });

  it('restores sessionId as undefined (not empty string) when absent', async () => {
    const noSession = baseLease();
    delete noSession.sessionId;
    await acquireMcpElicitationLease(redis, noSession, { ttlMs: 60_000 });
    const read = await readMcpElicitationLease(redis, 'elic-1');
    expect(read).not.toBeNull();
    expect(read!.sessionId).toBeUndefined();
  });
});

describe('releaseMcpElicitationLease', () => {
  let redis: RedisType;
  beforeEach(async () => {
    redis = createMockRedis();
    await redis.flushall();
  });

  it('deletes the lease when the calling instance is the holder', async () => {
    await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 60_000 });
    await releaseMcpElicitationLease(redis, 'elic-1', 'exec-A');
    expect(await readMcpElicitationLease(redis, 'elic-1')).toBeNull();
  });

  it('does NOT delete when a different instance holds the lease', async () => {
    await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 60_000 });
    await releaseMcpElicitationLease(redis, 'elic-1', 'exec-IMPOSTOR');
    expect(await readMcpElicitationLease(redis, 'elic-1')).not.toBeNull();
  });

  it('is a no-op when the lease does not exist (safe in handler finally)', async () => {
    await expect(
      releaseMcpElicitationLease(redis, 'elic-missing', 'exec-A'),
    ).resolves.toBeUndefined();
  });
});

describe('forceDeleteMcpElicitationLease', () => {
  let redis: RedisType;
  beforeEach(async () => {
    redis = createMockRedis();
    await redis.flushall();
  });

  it('deletes regardless of holder (reconciler path)', async () => {
    await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 60_000 });
    await forceDeleteMcpElicitationLease(redis, 'exec-A', 'elic-1');
    expect(await readMcpElicitationLease(redis, 'elic-1')).toBeNull();
    expect(await indexedMembers(redis)).toEqual([]);
  });

  it('is idempotent on missing keys', async () => {
    await expect(
      forceDeleteMcpElicitationLease(redis, 'exec-A', 'elic-missing'),
    ).resolves.toBeUndefined();
  });
});

describe('elicitation lease candidate index', () => {
  let redis: RedisType;
  beforeEach(async () => {
    redis = createMockRedis();
    await redis.flushall();
  });

  it('arms a candidate in the same call that grants the lease', async () => {
    await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 900_000 });
    expect(await indexedMembers(redis)).toEqual([
      mcpElicitationCandidateMember('exec-A', 'elic-1'),
    ]);
  });

  it('scores a fresh lease by the re-check interval, not the lease deadline', async () => {
    // A 15-minute lease whose holder can die at any moment must be looked at
    // long before its own expiry, or a dead holder goes unnoticed for a TTL.
    await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 900_000 });
    expect(await peekDueMcpElicitationLeaseCandidates(redis, 10, Date.now() + 31_000)).toHaveLength(
      1,
    );
  });

  it('leaves a fresh lease undue at the moment it is granted', async () => {
    await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 900_000 });
    expect(await peekDueMcpElicitationLeaseCandidates(redis, 10, Date.now())).toEqual([]);
  });

  it('pushes the candidate forward on every holder heartbeat', async () => {
    await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 60_000 });
    const armed = await redis.zscore(
      StreamKeys.mcpElicitationLeaseCandidatesKey,
      mcpElicitationCandidateMember('exec-A', 'elic-1'),
    );
    await new Promise((r) => setTimeout(r, 5));
    await refreshMcpElicitationLease(redis, 'elic-1', 'exec-A', 60_000);
    const refreshed = await redis.zscore(
      StreamKeys.mcpElicitationLeaseCandidatesKey,
      mcpElicitationCandidateMember('exec-A', 'elic-1'),
    );
    expect(Number(refreshed)).toBeGreaterThan(Number(armed));
  });

  it('clears the candidate when the holder releases', async () => {
    await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 60_000 });
    await releaseMcpElicitationLease(redis, 'elic-1', 'exec-A');
    expect(await indexedMembers(redis)).toEqual([]);
  });

  it('never lets one holder un-index another holder', async () => {
    await acquireMcpElicitationLease(redis, baseLease(), { ttlMs: 60_000 });
    await releaseMcpElicitationLease(redis, 'elic-1', 'exec-IMPOSTOR');
    expect(await indexedMembers(redis)).toEqual([
      mcpElicitationCandidateMember('exec-A', 'elic-1'),
    ]);
  });
});
