import type { Redis } from 'ioredis';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SHARD_COUNT, shardFor } from '@aflow/redis';

// Mock the redis shard functions
vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    acquireAvailableShards: vi.fn(),
    releaseShards: vi.fn(),
    listShardPendingMessages: vi.fn(),
    claimShardPendingMessages: vi.fn(),
    getShardRegistryEntry: vi.fn(),
    repairDueShardIndex: vi.fn(async () => undefined),
  };
});

import {
  acquireAvailableShards,
  releaseShards,
  listShardPendingMessages,
  claimShardPendingMessages,
  getShardRegistryEntry,
} from '@aflow/redis';
import { createShardManager } from '../ShardManager.js';

const mockAcquire = acquireAvailableShards as ReturnType<typeof vi.fn>;
const mockRelease = releaseShards as ReturnType<typeof vi.fn>;
const mockListPending = listShardPendingMessages as ReturnType<typeof vi.fn>;
const mockClaimPending = claimShardPendingMessages as ReturnType<typeof vi.fn>;
const mockGetRegistryEntry = getShardRegistryEntry as ReturnType<typeof vi.fn>;

// Fake redis instance (not actually used since functions are mocked)
const fakeRedis = {} as unknown as Redis;

beforeEach(() => {
  vi.useFakeTimers();
  mockAcquire.mockReset();
  mockRelease.mockReset();
  mockListPending.mockReset().mockResolvedValue([]);
  mockClaimPending.mockReset().mockResolvedValue([]);
  mockGetRegistryEntry.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ShardManager', () => {
  it('acquires all shards on start', async () => {
    // Simulate acquiring all 128 shards
    const allShards = Array.from({ length: SHARD_COUNT }, (_, i) => ({
      shardId: i,
      fencingToken: i + 1,
    }));
    mockAcquire.mockResolvedValue(allShards);
    mockRelease.mockResolvedValue(undefined);

    const manager = createShardManager(fakeRedis, { instanceId: 'test-1' });
    await manager.start();

    expect(manager.ownedShards().length).toBe(SHARD_COUNT);
    expect(mockAcquire).toHaveBeenCalledWith(fakeRedis, 'test-1', SHARD_COUNT, new Set());

    await manager.stop();
  });

  it('ownsRun returns true for all runs when all shards owned', async () => {
    const allShards = Array.from({ length: SHARD_COUNT }, (_, i) => ({
      shardId: i,
      fencingToken: i + 1,
    }));
    mockAcquire.mockResolvedValue(allShards);
    mockRelease.mockResolvedValue(undefined);

    const manager = createShardManager(fakeRedis, { instanceId: 'test-1' });
    await manager.start();

    // Any runId should be owned
    expect(manager.ownsRun('00000000-0000-0000-0000-000000000001')).toBe(true);
    expect(manager.ownsRun('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true);
    expect(manager.ownsRun('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(true);

    await manager.stop();
  });

  it('ownsRun returns false for runs on unowned shards', async () => {
    // Only acquire shard 0
    mockAcquire.mockResolvedValue([{ shardId: 0, fencingToken: 1 }]);
    mockRelease.mockResolvedValue(undefined);

    const manager = createShardManager(fakeRedis, { instanceId: 'test-1' });
    await manager.start();

    expect(manager.ownedShards().length).toBe(1);

    // Find a runId that maps to shard 0 and one that doesn't
    let runOnShard0: string | undefined;
    let runNotOnShard0: string | undefined;
    for (let i = 0; i < 200; i++) {
      const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
      if (shardFor(id) === 0 && !runOnShard0) {
        runOnShard0 = id;
      }
      if (shardFor(id) !== 0 && !runNotOnShard0) {
        runNotOnShard0 = id;
      }
      if (runOnShard0 && runNotOnShard0) break;
    }

    expect(runOnShard0).toBeDefined();
    expect(runNotOnShard0).toBeDefined();
    expect(manager.ownsRun(runOnShard0!)).toBe(true);
    expect(manager.ownsRun(runNotOnShard0!)).toBe(false);

    await manager.stop();
  });

  it('releases all shards on stop', async () => {
    const allShards = Array.from({ length: SHARD_COUNT }, (_, i) => ({
      shardId: i,
      fencingToken: i + 1,
    }));
    mockAcquire.mockResolvedValue(allShards);
    mockRelease.mockResolvedValue(undefined);

    const manager = createShardManager(fakeRedis, { instanceId: 'test-1' });
    await manager.start();
    await manager.stop();

    expect(mockRelease).toHaveBeenCalledWith(
      fakeRedis,
      'test-1',
      expect.arrayContaining([0, 1, 2]),
      expect.any(Map),
    );
    expect(manager.ownedShards().length).toBe(0);
  });

  it('calls onShardsAcquired callback with newly acquired shards', async () => {
    const allShards = Array.from({ length: SHARD_COUNT }, (_, i) => ({
      shardId: i,
      fencingToken: i + 1,
    }));
    mockAcquire.mockResolvedValue(allShards);
    mockRelease.mockResolvedValue(undefined);

    const onAcquired = vi.fn().mockResolvedValue(undefined);
    const manager = createShardManager(fakeRedis, {
      instanceId: 'test-1',
      onShardsAcquired: onAcquired,
    });

    await manager.start();

    expect(onAcquired).toHaveBeenCalledTimes(1);
    expect(onAcquired).toHaveBeenCalledWith(expect.arrayContaining([0, 1, 2, 3]));
    expect(onAcquired.mock.calls[0][0].length).toBe(SHARD_COUNT);

    await manager.stop();
  });

  it('tracks fencing tokens per shard', async () => {
    mockAcquire.mockResolvedValue([
      { shardId: 5, fencingToken: 42 },
      { shardId: 10, fencingToken: 99 },
    ]);
    mockRelease.mockResolvedValue(undefined);

    const manager = createShardManager(fakeRedis, { instanceId: 'test-1' });
    await manager.start();

    expect(manager.fencingToken(5)).toBe(42);
    expect(manager.fencingToken(10)).toBe(99);
    expect(manager.fencingToken(0)).toBe(0); // not owned

    await manager.stop();
  });

  it('respects maxShards limit', async () => {
    // When maxShards=10, acquireAvailableShards is called with limit=10
    // and should return at most 10 shards
    const tenShards = Array.from({ length: 10 }, (_, i) => ({
      shardId: i,
      fencingToken: i + 1,
    }));
    mockAcquire.mockResolvedValue(tenShards);
    mockRelease.mockResolvedValue(undefined);

    const manager = createShardManager(fakeRedis, {
      instanceId: 'test-1',
      maxShards: 10,
    });
    await manager.start();

    expect(manager.ownedShards().length).toBe(10);
    // Verify maxShards was passed down to acquireAvailableShards
    expect(mockAcquire).toHaveBeenCalledWith(fakeRedis, 'test-1', 10, new Set());

    await manager.stop();
  });

  it('does not write any per-shard liveness of its own', async () => {
    // Liveness moved to one per-instance record. A shard manager that kept
    // refreshing a marker per shard is what let an instance keep a shard it had
    // already lost looking busy to everyone else.
    const allShards = Array.from({ length: 4 }, (_, i) => ({
      shardId: i,
      fencingToken: i + 1,
    }));
    mockAcquire.mockResolvedValue(allShards);
    mockRelease.mockResolvedValue(undefined);
    mockListPending.mockResolvedValue([]);

    const manager = createShardManager(fakeRedis, { instanceId: 'test-1' });
    await manager.start();

    await vi.advanceTimersByTimeAsync(10_100);
    expect(manager.ownedShards()).toEqual(expect.arrayContaining([0, 1, 2, 3]));

    await manager.stop();
  });
});
