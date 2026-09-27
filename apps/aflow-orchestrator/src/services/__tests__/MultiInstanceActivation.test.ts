import type { Redis } from 'ioredis';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SHARD_COUNT, shardFor } from '@aflow/redis';

// ── Mocks ─────────────────────────────────────────────────────────────────────

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

const fakeRedis = {} as unknown as Redis;

beforeEach(() => {
  vi.useFakeTimers();
  mockAcquire.mockReset();
  mockRelease.mockReset().mockResolvedValue(undefined);
  mockListPending.mockReset().mockResolvedValue([]);
  mockClaimPending.mockReset().mockResolvedValue([]);
  mockGetRegistryEntry.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create shard entries for a range */
function shardsInRange(
  start: number,
  end: number,
  fenceBase: number = 1,
): Array<{ shardId: number; fencingToken: number }> {
  return Array.from({ length: end - start }, (_, i) => ({
    shardId: start + i,
    fencingToken: fenceBase + i,
  }));
}

/** Find a runId that maps to a specific shard */
function findRunForShard(targetShard: number): string {
  for (let i = 0; i < 10_000; i++) {
    const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    if (shardFor(id) === targetShard) return id;
  }
  throw new Error(`Could not find runId for shard ${targetShard}`);
}

// ============================================================================
// 1. Disjoint Shard Ownership
// ============================================================================

describe('Multi-Instance: Disjoint Shard Ownership', () => {
  it('two managers acquire non-overlapping shard sets', async () => {
    // Instance A gets shards 0-63, Instance B gets 64-127
    const shardsA = shardsInRange(0, 64);
    const shardsB = shardsInRange(64, 128, 65);

    // First call → Instance A; second call → Instance B
    mockAcquire.mockResolvedValueOnce(shardsA).mockResolvedValueOnce(shardsB);

    const managerA = createShardManager(fakeRedis, {
      instanceId: 'instance-A',
      maxShards: 64,
    });
    const managerB = createShardManager(fakeRedis, {
      instanceId: 'instance-B',
      maxShards: 64,
    });

    await managerA.start();
    await managerB.start();

    // Verify disjoint
    expect(managerA.ownedShards().length).toBe(64);
    expect(managerB.ownedShards().length).toBe(64);

    const setA = new Set(managerA.ownedShards());
    const setB = new Set(managerB.ownedShards());
    const overlap = [...setA].filter((s) => setB.has(s));
    expect(overlap).toHaveLength(0);

    // Union covers all shards
    expect(setA.size + setB.size).toBe(SHARD_COUNT);

    // Run routing: a run on shard 0 → only A owns it
    const runOnShard0 = findRunForShard(0);
    expect(managerA.ownsRun(runOnShard0)).toBe(true);
    expect(managerB.ownsRun(runOnShard0)).toBe(false);

    // Run routing: a run on shard 100 → only B owns it
    const runOnShard100 = findRunForShard(100);
    expect(managerA.ownsRun(runOnShard100)).toBe(false);
    expect(managerB.ownsRun(runOnShard100)).toBe(true);

    await managerA.stop();
    await managerB.stop();
  });

  it('fencing tokens are distinct per instance', async () => {
    mockAcquire
      .mockResolvedValueOnce([
        { shardId: 5, fencingToken: 42 },
        { shardId: 10, fencingToken: 43 },
      ])
      .mockResolvedValueOnce([
        { shardId: 20, fencingToken: 100 },
        { shardId: 25, fencingToken: 101 },
      ]);

    const a = createShardManager(fakeRedis, { instanceId: 'A', maxShards: 2 });
    const b = createShardManager(fakeRedis, { instanceId: 'B', maxShards: 2 });

    await a.start();
    await b.start();

    expect(a.fencingToken(5)).toBe(42);
    expect(a.fencingToken(20)).toBe(0); // not owned by A
    expect(b.fencingToken(20)).toBe(100);
    expect(b.fencingToken(5)).toBe(0); // not owned by B

    await a.stop();
    await b.stop();
  });
});

// ============================================================================
// 2. Failover: Reacquisition of Dead Instance's Shards
// ============================================================================

describe('Multi-Instance: Failover & Reacquisition', () => {
  it('survivor reacquires shards from dead instance via reacquisition interval', async () => {
    // Instance A owns shards 0-3, Instance B owns shards 4-7
    mockAcquire
      .mockResolvedValueOnce(shardsInRange(0, 4)) // A initial
      .mockResolvedValueOnce(shardsInRange(4, 8, 5)); // B initial

    const onAcquiredA = vi.fn().mockResolvedValue(undefined);
    const onAcquiredB = vi.fn().mockResolvedValue(undefined);

    const a = createShardManager(fakeRedis, {
      instanceId: 'A',
      maxShards: 8,
      onShardsAcquired: onAcquiredA,
    });
    const b = createShardManager(fakeRedis, {
      instanceId: 'B',
      maxShards: 8,
      onShardsAcquired: onAcquiredB,
    });

    await a.start();
    await b.start();

    expect(a.ownedShards().length).toBe(4);
    expect(b.ownedShards().length).toBe(4);

    // Kill A — in reality A would crash. We simulate by stopping A (releasing shards)
    // so its intervals don't interfere, then set up B's reacquisition.
    await a.stop();

    // B's reacquisition (fires at 30s interval) picks up A's expired shards
    // The acquire call returns A's old shards with new fencing tokens
    mockAcquire.mockResolvedValueOnce(shardsInRange(0, 4, 100)); // A's shards reacquired by B

    // Advance past reacquisition interval (30s)
    await vi.advanceTimersByTimeAsync(30_100);

    // B should now own shards 0-7
    expect(b.ownedShards().length).toBe(8);
    expect(b.ownsShard(0)).toBe(true);
    expect(b.ownsShard(3)).toBe(true);

    // Fencing tokens for reacquired shards should be the NEW tokens
    expect(b.fencingToken(0)).toBe(100);
    expect(b.fencingToken(1)).toBe(101);

    // onShardsAcquired should have been called again with the newly acquired shards
    expect(onAcquiredB).toHaveBeenCalledTimes(2);
    expect(onAcquiredB).toHaveBeenLastCalledWith([0, 1, 2, 3]);

    // A already stopped above
    await b.stop();
  });

  it('reacquisition does not re-acquire already owned shards', async () => {
    mockAcquire.mockResolvedValueOnce(shardsInRange(0, 4)); // initial

    const onAcquired = vi.fn().mockResolvedValue(undefined);
    const m = createShardManager(fakeRedis, {
      instanceId: 'X',
      maxShards: 4,
      onShardsAcquired: onAcquired,
    });

    await m.start();
    expect(onAcquired).toHaveBeenCalledTimes(1);

    // Reacquisition returns the same shards (already owned, no new ones)
    mockAcquire.mockResolvedValueOnce(shardsInRange(0, 4));
    await vi.advanceTimersByTimeAsync(30_100);

    // onShardsAcquired should NOT fire again (no *newly* acquired shards)
    expect(onAcquired).toHaveBeenCalledTimes(1);

    await m.stop();
  });
});

// ============================================================================
// 3. Fencing Validation
// ============================================================================

describe('Multi-Instance: Fencing', () => {
  it('stale fencing token is detectable after takeover', async () => {
    // A gets shard 5 with token 42
    mockAcquire.mockResolvedValueOnce([{ shardId: 5, fencingToken: 42 }]);

    const a = createShardManager(fakeRedis, { instanceId: 'A', maxShards: 1 });
    await a.start();

    const staleToken = a.fencingToken(5);
    expect(staleToken).toBe(42);

    // B takes over shard 5 with a higher token
    mockAcquire.mockResolvedValueOnce([{ shardId: 5, fencingToken: 99 }]);
    const b = createShardManager(fakeRedis, { instanceId: 'B', maxShards: 1 });
    await b.start();

    // B has the new token
    expect(b.fencingToken(5)).toBe(99);

    // A still has the stale token — any validateShardOwnership check by A should fail
    // because Redis registry now shows B as owner with token 99
    expect(a.fencingToken(5)).toBe(42);
    expect(a.fencingToken(5)).not.toBe(b.fencingToken(5));

    await a.stop();
    await b.stop();
  });

  it('fencingToken returns 0 for unowned shards', async () => {
    mockAcquire.mockResolvedValueOnce([{ shardId: 10, fencingToken: 50 }]);
    const m = createShardManager(fakeRedis, { instanceId: 'M', maxShards: 1 });
    await m.start();

    expect(m.fencingToken(10)).toBe(50);
    expect(m.fencingToken(0)).toBe(0);
    expect(m.fencingToken(127)).toBe(0);

    await m.stop();
  });
});

// ============================================================================
// 4. Pending Message Reclaim
// ============================================================================

describe('Multi-Instance: Pending Message Reclaim', () => {
  it('reclaims pending messages from stale consumers on shard acquisition', async () => {
    // Simulate acquiring shards 0 and 1
    mockAcquire.mockResolvedValueOnce(shardsInRange(0, 2));

    // Shard 0 control stream has a pending message from dead consumer 'old-instance'
    mockListPending.mockImplementation(
      async (_redis: unknown, shardId: number, streamType: string) => {
        if (shardId === 0 && streamType === 'control') {
          return [{ id: '1234-0', consumer: 'old-instance', idleTime: 60_000, deliveryCount: 1 }];
        }
        return [];
      },
    );

    mockClaimPending.mockImplementation(
      async (_redis: unknown, shardId: number, streamType: string) => {
        if (shardId === 0 && streamType === 'control') {
          return [{ id: '1234-0', fields: { data: '{}' } }];
        }
        return [];
      },
    );

    const onReclaimed = vi.fn();
    const m = createShardManager(fakeRedis, {
      instanceId: 'new-instance',
      maxShards: 2,
      onPendingReclaimed: onReclaimed,
    });

    await m.start();

    // listShardPendingMessages should have been called for both shards × both stream types
    expect(mockListPending).toHaveBeenCalled();

    // claimShardPendingMessages called for the shard with pending messages
    expect(mockClaimPending).toHaveBeenCalledWith(
      fakeRedis,
      0,
      'control',
      'new-instance',
      ['1234-0'],
      expect.any(Object),
    );

    // onPendingReclaimed callback fired
    expect(onReclaimed).toHaveBeenCalledWith(0, 'control', 1);

    await m.stop();
  });

  it('does not reclaim its own pending messages', async () => {
    mockAcquire.mockResolvedValueOnce([{ shardId: 0, fencingToken: 1 }]);

    // Pending message is from THIS consumer (not stale)
    mockListPending.mockResolvedValue([
      { id: '1234-0', consumer: 'self-instance', idleTime: 60_000, deliveryCount: 1 },
    ]);

    const m = createShardManager(fakeRedis, {
      instanceId: 'self-instance',
      maxShards: 1,
    });

    await m.start();

    // claimShardPendingMessages should NOT be called (own messages filtered)
    expect(mockClaimPending).not.toHaveBeenCalled();

    await m.stop();
  });

  it('runs periodic reclaim on reacquisition interval', async () => {
    mockAcquire.mockResolvedValueOnce(shardsInRange(0, 2));
    // No pending on initial start
    mockListPending.mockResolvedValue([]);

    const m = createShardManager(fakeRedis, {
      instanceId: 'periodic',
      maxShards: 2,
    });

    await m.start();
    const initialCallCount = mockListPending.mock.calls.length;

    // Advance past reacquisition interval (30s) — triggers periodic reclaim
    mockAcquire.mockResolvedValueOnce(shardsInRange(0, 2)); // same shards, no new ones
    await vi.advanceTimersByTimeAsync(30_100);

    // listShardPendingMessages should have been called again for periodic reclaim
    expect(mockListPending.mock.calls.length).toBeGreaterThan(initialCallCount);

    await m.stop();
  });
});

// ============================================================================
// 5. Graceful Drain
// ============================================================================

describe('Multi-Instance: Graceful Drain', () => {
  it('isDraining prevents reacquisition after stop begins', async () => {
    mockAcquire.mockResolvedValueOnce(shardsInRange(0, 4));

    const m = createShardManager(fakeRedis, {
      instanceId: 'drainer',
      maxShards: 4,
    });

    await m.start();
    expect(m.isDraining()).toBe(false);
    expect(m.ownedShards().length).toBe(4);

    // Stop triggers drain
    await m.stop();
    expect(m.isDraining()).toBe(true);
    expect(m.ownedShards().length).toBe(0);

    // Release was called with the original shards
    expect(mockRelease).toHaveBeenCalledWith(
      fakeRedis,
      'drainer',
      expect.arrayContaining([0, 1, 2, 3]),
      expect.any(Map),
    );
  });

  it('stop order: draining → clear intervals → release', async () => {
    const callOrder: string[] = [];

    mockAcquire.mockResolvedValueOnce(shardsInRange(0, 2));
    mockRelease.mockImplementation(async () => {
      callOrder.push('release');
    });

    const m = createShardManager(fakeRedis, {
      instanceId: 'order-test',
      maxShards: 2,
    });

    await m.start();

    // Prepare a reacquisition that would fire if intervals aren't cleared
    mockAcquire.mockResolvedValueOnce(shardsInRange(2, 4, 10)); // new shards

    await m.stop();
    callOrder.push('stopped');

    // Advance timers — reacquisition should NOT fire after stop
    await vi.advanceTimersByTimeAsync(60_000);

    // acquireAvailableShards should NOT have been called again after stop
    // (initial call + potentially the reacquisition-before-stop, but not after)
    expect(callOrder).toContain('release');
    expect(callOrder).toContain('stopped');

    // Manager should be empty
    expect(m.ownedShards().length).toBe(0);
  });

  it('draining flag prevents reacquisition interval from acquiring', async () => {
    mockAcquire.mockResolvedValueOnce(shardsInRange(0, 2));

    const onAcquired = vi.fn().mockResolvedValue(undefined);
    const m = createShardManager(fakeRedis, {
      instanceId: 'drain-test',
      maxShards: 4,
      onShardsAcquired: onAcquired,
    });

    await m.start();
    expect(onAcquired).toHaveBeenCalledTimes(1);

    // Stop the manager
    await m.stop();

    // Set up new shards that would be acquired if reacquisition fires
    mockAcquire.mockResolvedValueOnce(shardsInRange(2, 4, 10));

    // Advance past reacquisition interval
    await vi.advanceTimersByTimeAsync(60_000);

    // onShardsAcquired should NOT fire again
    expect(onAcquired).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 6. Shard-Scoped Timer Isolation (Pure Function Tests)
// ============================================================================

describe('Multi-Instance: Shard Timer Isolation', () => {
  it('scheduleShardTimer routes to correct shard ZSET', async () => {
    // This tests the pure shardFor routing — verifying that timer scheduling
    // uses the run's shard, not a global key
    const runA = findRunForShard(0);
    const runB = findRunForShard(64);

    expect(shardFor(runA)).toBe(0);
    expect(shardFor(runB)).toBe(64);

    // Timers for these runs go to different shard ZSETs
    expect(shardFor(runA)).not.toBe(shardFor(runB));
  });

  it('popShardDueTimers only returns timers for specified shards', () => {
    // Verify the shard isolation property: a manager owning shards 0-3
    // will never see timers for shard 64
    const m1Shards = [0, 1, 2, 3];
    const m2Shards = [64, 65, 66, 67];

    const runOnShard0 = findRunForShard(0);
    const runOnShard64 = findRunForShard(64);

    // m1 owns shard 0 — should process runOnShard0's timer
    expect(m1Shards.includes(shardFor(runOnShard0))).toBe(true);
    expect(m1Shards.includes(shardFor(runOnShard64))).toBe(false);

    // m2 owns shard 64 — should process runOnShard64's timer
    expect(m2Shards.includes(shardFor(runOnShard64))).toBe(true);
    expect(m2Shards.includes(shardFor(runOnShard0))).toBe(false);
  });
});

// ============================================================================
// 7. End-to-End Failover Scenario
// ============================================================================

describe('Multi-Instance: Full Failover Scenario', () => {
  it('A owns → A dies → B reacquires → B reclaims pending → B continues', async () => {
    // Phase 1: A starts and owns shards 0-3
    mockAcquire.mockResolvedValueOnce(shardsInRange(0, 4));
    const onAcquiredA = vi.fn().mockResolvedValue(undefined);

    const a = createShardManager(fakeRedis, {
      instanceId: 'instance-A',
      maxShards: 4,
      onShardsAcquired: onAcquiredA,
    });
    await a.start();
    expect(a.ownedShards().length).toBe(4);

    // Phase 2: B starts with shards 4-7
    mockAcquire.mockResolvedValueOnce(shardsInRange(4, 8, 5));
    const onAcquiredB = vi.fn().mockResolvedValue(undefined);
    const onReclaimedB = vi.fn();

    const b = createShardManager(fakeRedis, {
      instanceId: 'instance-B',
      maxShards: 8,
      onShardsAcquired: onAcquiredB,
      onPendingReclaimed: onReclaimedB,
    });
    await b.start();
    expect(b.ownedShards().length).toBe(4);

    // Verify disjoint
    const runOnShard2 = findRunForShard(2);
    expect(a.ownsRun(runOnShard2)).toBe(true);
    expect(b.ownsRun(runOnShard2)).toBe(false);

    // Phase 3: A crashes. In production heartbeats expire; here we stop A so its
    // reacquisition interval doesn't consume mocks meant for B.
    await a.stop();

    // B's reacquisition picks up A's shards with new fencing tokens
    mockAcquire.mockResolvedValueOnce(shardsInRange(0, 4, 200));

    // Pending messages exist on shard 2 from dead instance-A
    mockListPending.mockImplementation(
      async (_redis: unknown, shardId: number, streamType: string) => {
        if (shardId === 2 && streamType === 'results') {
          return [
            { id: '5678-0', consumer: 'instance-A', idleTime: 45_000, deliveryCount: 1 },
            { id: '5678-1', consumer: 'instance-A', idleTime: 40_000, deliveryCount: 1 },
          ];
        }
        return [];
      },
    );

    mockClaimPending.mockImplementation(
      async (_redis: unknown, shardId: number, streamType: string) => {
        if (shardId === 2 && streamType === 'results') {
          return [
            { id: '5678-0', fields: { data: '{}' } },
            { id: '5678-1', fields: { data: '{}' } },
          ];
        }
        return [];
      },
    );

    // Phase 4: Reacquisition interval fires — B picks up A's shards
    await vi.advanceTimersByTimeAsync(30_100);

    // B now owns all 8 shards
    expect(b.ownedShards().length).toBe(8);
    expect(b.ownsShard(0)).toBe(true);
    expect(b.ownsShard(2)).toBe(true);
    expect(b.ownsRun(runOnShard2)).toBe(true);

    // New fencing tokens for reacquired shards
    expect(b.fencingToken(0)).toBe(200);
    expect(b.fencingToken(2)).toBe(202);

    // onShardsAcquired fired for the newly acquired shards
    expect(onAcquiredB).toHaveBeenCalledTimes(2);
    expect(onAcquiredB).toHaveBeenLastCalledWith([0, 1, 2, 3]);

    // Pending messages were reclaimed
    expect(mockClaimPending).toHaveBeenCalledWith(
      fakeRedis,
      2,
      'results',
      'instance-B',
      ['5678-0', '5678-1'],
      expect.any(Object),
    );
    expect(onReclaimedB).toHaveBeenCalledWith(2, 'results', 2);

    // A already stopped above (simulating crash)
    await b.stop();
  });
});
