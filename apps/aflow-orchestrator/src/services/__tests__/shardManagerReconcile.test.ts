/**
 * Ownership reconciliation: in-memory `owned` otherwise shrinks only on
 * shutdown or a fencing failure during actual work, so an instance resuming
 * after a stall keeps phantom ownership of every idle shard a peer took,
 * counts them against maxShards, and can never acquire again.
 */
import type { Redis } from 'ioredis';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSetShardOwnershipCount = vi.fn();
vi.mock('@aflow/observability', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  setShardOwnershipCount: (...args: unknown[]) => mockSetShardOwnershipCount(...args),
}));

vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    acquireAvailableShards: vi.fn(),
    releaseShards: vi.fn(),
    listShardPendingMessages: vi.fn(),
    claimShardPendingMessages: vi.fn(),
    getShardOwnerMap: vi.fn(),
    repairDueShardIndex: vi.fn(async () => undefined),
  };
});

import {
  acquireAvailableShards,
  releaseShards,
  listShardPendingMessages,
  claimShardPendingMessages,
  getShardOwnerMap,
} from '@aflow/redis';
import { createShardManager } from '../ShardManager.js';

const mockAcquire = acquireAvailableShards as ReturnType<typeof vi.fn>;
const mockRelease = releaseShards as ReturnType<typeof vi.fn>;
const mockListPending = listShardPendingMessages as ReturnType<typeof vi.fn>;
const mockClaimPending = claimShardPendingMessages as ReturnType<typeof vi.fn>;
const mockOwnerMap = getShardOwnerMap as ReturnType<typeof vi.fn>;

const fakeRedis = {} as unknown as Redis;
const ME = 'orchestrator-reconcile-test';

beforeEach(() => {
  vi.useFakeTimers();
  mockAcquire.mockReset();
  mockRelease.mockReset().mockResolvedValue(undefined);
  mockListPending.mockReset().mockResolvedValue([]);
  mockClaimPending.mockReset().mockResolvedValue([]);
  mockOwnerMap.mockReset().mockResolvedValue(new Map());
  mockSetShardOwnershipCount.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ShardManager ownership reconciliation', () => {
  it('drops every shard the registry no longer grants this instance', async () => {
    mockAcquire.mockResolvedValueOnce([
      { shardId: 0, fencingToken: 10 },
      { shardId: 1, fencingToken: 11 },
      { shardId: 2, fencingToken: 12 },
      { shardId: 3, fencingToken: 13 },
    ]);
    const manager = createShardManager(fakeRedis, { instanceId: ME, maxShards: 4 });
    await manager.start();
    expect(manager.ownedShards()).toEqual([0, 1, 2, 3]);

    mockOwnerMap.mockResolvedValue(
      new Map([
        // Still mine, same token — kept.
        [0, { owner: ME, leaseVersion: 10, leasedAt: 1 }],
        // A peer took it past my lease — dropped.
        [1, { owner: 'peer', leaseVersion: 99, leasedAt: 2 }],
        // Same owner name but a newer token: a restart under a fixed
        // instance id re-acquired it; this process's token is stale — dropped.
        [3, { owner: ME, leaseVersion: 99, leasedAt: 3 }],
        // Shard 2 absent from the registry entirely — dropped.
      ]),
    );

    await manager.reconcile();

    expect(manager.ownedShards()).toEqual([0]);
    expect(manager.fencingToken(0)).toBe(10);
    expect(manager.fencingToken(1)).toBe(0);
    expect(manager.fencingToken(2)).toBe(0);
    expect(manager.fencingToken(3)).toBe(0);
    expect(manager.ownsShard(1)).toBe(false);
  });

  it('drops a shard whose entry this instance released', async () => {
    mockAcquire.mockResolvedValueOnce([{ shardId: 5, fencingToken: 20 }]);
    const manager = createShardManager(fakeRedis, { instanceId: ME, maxShards: 1 });
    await manager.start();

    mockOwnerMap.mockResolvedValue(
      new Map([[5, { owner: ME, leaseVersion: 20, leasedAt: 1, released: true }]]),
    );
    await manager.reconcile();

    expect(manager.ownedShards()).toEqual([]);
  });

  it('a cycle caught mid-await by shutdown stops before acquiring', async () => {
    // The draining check runs before the chain starts; shutdown landing while
    // reconcile awaits Redis must stop the chain at the next phase boundary,
    // and stop() must wait for it — an acquisition or recovery firing after
    // ownership was released belongs to a dead instance.
    mockAcquire.mockResolvedValueOnce([{ shardId: 0, fencingToken: 1 }]);
    const manager = createShardManager(fakeRedis, { instanceId: ME, maxShards: 4 });
    await manager.start();
    expect(mockAcquire).toHaveBeenCalledTimes(1);

    let releaseReconcile!: () => void;
    mockOwnerMap.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseReconcile = () =>
            resolve(new Map([[0, { owner: ME, leaseVersion: 1, leasedAt: 1 }]]));
        }),
    );

    // Fire the interval: the chain parks inside reconcile's registry read.
    await vi.advanceTimersByTimeAsync(30_000);

    const stopping = manager.stop();
    releaseReconcile();
    await stopping;

    // The chain's acquire phase must have been skipped, not raced.
    expect(mockAcquire).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('a fencing revoke emits its ownership delta', async () => {
    mockAcquire.mockResolvedValueOnce([{ shardId: 9, fencingToken: 40 }]);
    const manager = createShardManager(fakeRedis, { instanceId: ME, maxShards: 1 });
    await manager.start();
    mockSetShardOwnershipCount.mockClear();

    manager.revokeShard(9);

    expect(mockSetShardOwnershipCount).toHaveBeenCalledWith(-1, { instance_id: ME });
  });

  it('touches nothing while the registry still grants everything', async () => {
    mockAcquire.mockResolvedValueOnce([
      { shardId: 7, fencingToken: 30 },
      { shardId: 8, fencingToken: 31 },
    ]);
    const manager = createShardManager(fakeRedis, { instanceId: ME, maxShards: 2 });
    await manager.start();

    mockOwnerMap.mockResolvedValue(
      new Map([
        [7, { owner: ME, leaseVersion: 30, leasedAt: 1 }],
        [8, { owner: ME, leaseVersion: 31, leasedAt: 1 }],
      ]),
    );
    await manager.reconcile();

    expect(manager.ownedShards()).toEqual([7, 8]);
    expect(manager.fencingToken(7)).toBe(30);
  });
});
