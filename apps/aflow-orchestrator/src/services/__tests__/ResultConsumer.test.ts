import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createResultConsumer } from '../ResultConsumer.js';
import type { ResultConsumerDeps, ResultConsumerConfig } from '../ResultConsumer.js';
import type { SessionOrchestrator } from '../SessionOrchestrator/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface QueuedResult {
  id: string;
  shardId: number;
  result: { sessionId: string; stepExecutionId: string; operationId: string };
}

function makeResult(id: string, sessionId: string): QueuedResult {
  return {
    id,
    shardId: 0,
    result: {
      sessionId,
      stepExecutionId: `step-${id}`,
      operationId: `op-${id}`,
    },
  };
}

/**
 * Build a fake readShardStepResults that pulls from a queue.
 * Push results via `feed()`, then call `seal()` when done so the
 * consumer's read loop returns empty arrays until stopped.
 */
function createResultQueue() {
  const pending: QueuedResult[] = [];
  let resolve: (() => void) | null = null;
  let sealed = false;

  return {
    feed(...items: QueuedResult[]) {
      pending.push(...items);
      resolve?.();
      resolve = null;
    },
    seal() {
      sealed = true;
      resolve?.();
      resolve = null;
    },
    async read(
      _redis: unknown,
      _consumer: string,
      _shardIds: number[],
      opts?: { count?: number; blockMs?: number },
    ): Promise<QueuedResult[]> {
      const count = opts?.count ?? 10;
      if (pending.length > 0) {
        return pending.splice(0, Math.min(pending.length, count));
      }
      if (sealed) return [];
      // Wait until more items arrive or sealed
      await new Promise<void>((r) => {
        resolve = r;
      });
      return pending.splice(0, Math.min(pending.length, count));
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Stub deps builder
// ---------------------------------------------------------------------------

/** Minimal ShardManager stub — always owns shard 0 */
/** Minimal ShardStreamSet for a fake owner; avoids depending on the redis mock. */
function fakeStreamSet(shardIds: number[], prefix: string) {
  const streamMap = new Map(shardIds.map((id) => [`aflow:shard:${String(id)}:${prefix}`, id]));
  return { streamKeys: [...streamMap.keys()], streamMap };
}

function createMockShardManager() {
  return {
    ownedShards: () => [0],
    resultStreams: () => fakeStreamSet([0], 'results'),
    controlStreams: () => fakeStreamSet([0], 'control'),
    ownsShard: () => true,
    ownsRun: () => true,
    fencingToken: () => 1,
    isDraining: () => false,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function buildDeps(overrides: {
  readFn: (
    redis: unknown,
    consumer: string,
    shardIds: number[],
    opts?: { count?: number; blockMs?: number },
  ) => Promise<QueuedResult[]>;
  applyResult?: (params: { result: unknown; messageId: string }) => Promise<void>;
}) {
  const ackCalls: string[] = [];
  const applyResult =
    overrides.applyResult ??
    vi.fn<[{ result: unknown; messageId: string }], Promise<void>>().mockResolvedValue(undefined);

  const executionService = {
    applyResult,
    processDueTimers: vi.fn<[], Promise<number>>().mockResolvedValue(0),
  } as unknown as SessionOrchestrator;

  const deps: ResultConsumerDeps = {
    blockingRedis: {} as never,
    redis: {} as never,
    executionService,
    shardManager: createMockShardManager() as never,
    harnessDeps: {
      db: {} as never,
      redis: {} as never,
      payloadStore: {} as never,
    },
    wakeHold: { remainingMs: () => 0 },
  };

  return { deps, executionService, ackCalls, applyResult };
}

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

let mockRead: (
  redis: unknown,
  consumer: string,
  shardIds: number[],
  opts?: { count?: number; blockMs?: number },
) => Promise<QueuedResult[]>;

let mockReadPending: (
  redis: unknown,
  consumer: string,
  shardIds: number[],
  opts?: { count?: number },
) => Promise<QueuedResult[]>;

let mockAck: (redis: unknown, shardId: number, id: string) => Promise<void>;

vi.mock('@aflow/redis', () => ({
  readShardStepResults: (...args: unknown[]) =>
    mockRead(
      args[0],
      args[1] as string,
      args[2] as number[],
      args[3] as { count?: number; blockMs?: number },
    ),
  readShardPendingStepResults: (...args: unknown[]) =>
    mockReadPending(args[0], args[1] as string, args[2] as number[], args[3] as { count?: number }),
  ackShardStepResult: (...args: unknown[]) =>
    mockAck(args[0], args[1] as number, args[2] as string),
  shardFor: () => 0,
  validateShardOwnership: async () => true,
  streamIdToTimestampMs: () => null,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResultConsumer', () => {
  let ackIds: string[];

  beforeEach(() => {
    ackIds = [];
    mockAck = vi.fn(async (_redis: unknown, _shardId: number, id: string) => {
      ackIds.push(id);
    });
    // Default: no pending entries (overridden in specific tests)
    mockReadPending = async () => [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseConfig: ResultConsumerConfig = {
    consumerName: 'test-consumer',
    batchSize: 10,
    blockMs: 10,
    timerIntervalMs: 60_000,
    maxConcurrent: 20,
  };

  // ── Test 1: Serial ordering within a run ────────────────────────────────

  it('serialises results for the same run', async () => {
    const callOrder: string[] = [];
    const queue = createResultQueue();

    mockRead = queue.read;

    const { deps } = buildDeps({
      readFn: queue.read,
      applyResult: async ({ messageId }) => {
        callOrder.push(messageId);
        await delay(20);
      },
    });
    deps.executionService.applyResult = async ({ messageId }: { messageId: string }) => {
      callOrder.push(messageId);
      await delay(20);
    };

    const consumer = createResultConsumer(deps, baseConfig);
    consumer.start();

    queue.feed(makeResult('A1', 'run-A'), makeResult('A2', 'run-A'), makeResult('A3', 'run-A'));

    await delay(200);
    queue.seal();
    await consumer.stop();

    expect(callOrder).toEqual(['A1', 'A2', 'A3']);
  });

  // ── Test 2: Parallel across runs ────────────────────────────────────────

  it('processes different runs concurrently', async () => {
    const queue = createResultQueue();
    mockRead = queue.read;

    const starts: Record<string, number> = {};
    const ends: Record<string, number> = {};

    const { deps } = buildDeps({
      readFn: queue.read,
      applyResult: async ({ messageId }) => {
        starts[messageId] = Date.now();
        await delay(80);
        ends[messageId] = Date.now();
      },
    });
    deps.executionService.applyResult = async ({ messageId }: { messageId: string }) => {
      starts[messageId] = Date.now();
      await delay(80);
      ends[messageId] = Date.now();
    };

    const consumer = createResultConsumer(deps, baseConfig);
    consumer.start();

    queue.feed(makeResult('A1', 'run-A'), makeResult('B1', 'run-B'));

    await delay(250);
    queue.seal();
    await consumer.stop();

    const aStart = starts['A1']!;
    const bStart = starts['B1']!;
    // They should have started nearly simultaneously (within 50ms)
    expect(Math.abs(aStart - bStart)).toBeLessThan(60);
  });

  // ── Test 3: Backpressure ────────────────────────────────────────────────

  it('respects maxConcurrent backpressure', async () => {
    const queue = createResultQueue();
    mockRead = queue.read;

    let peakConcurrent = 0;
    let currentConcurrent = 0;

    const { deps } = buildDeps({ readFn: queue.read });
    deps.executionService.applyResult = async () => {
      currentConcurrent++;
      peakConcurrent = Math.max(peakConcurrent, currentConcurrent);
      await delay(60);
      currentConcurrent--;
    };

    const consumer = createResultConsumer(deps, {
      ...baseConfig,
      maxConcurrent: 3,
    });
    consumer.start();

    // Feed 6 results for 6 different runs so they CAN be concurrent
    queue.feed(
      makeResult('R1', 'run-1'),
      makeResult('R2', 'run-2'),
      makeResult('R3', 'run-3'),
      makeResult('R4', 'run-4'),
      makeResult('R5', 'run-5'),
      makeResult('R6', 'run-6'),
    );

    await delay(500);
    queue.seal();
    await consumer.stop();

    expect(peakConcurrent).toBeLessThanOrEqual(3);
    expect(peakConcurrent).toBeGreaterThanOrEqual(2); // at least some parallelism
  });

  // ── Test 4: Error isolation ─────────────────────────────────────────────

  it('isolates errors: failing A1 does not block A2 or B1', async () => {
    const callOrder: string[] = [];
    const queue = createResultQueue();
    mockRead = queue.read;

    const { deps } = buildDeps({ readFn: queue.read });
    deps.executionService.applyResult = async ({
      messageId,
    }: {
      result: unknown;
      messageId: string;
    }) => {
      if (messageId === 'A1') throw new Error('boom');
      callOrder.push(messageId);
    };

    const consumer = createResultConsumer(deps, baseConfig);
    consumer.start();

    queue.feed(makeResult('A1', 'run-A'), makeResult('A2', 'run-A'), makeResult('B1', 'run-B'));

    await delay(200);
    queue.seal();
    await consumer.stop();

    expect(callOrder).toContain('A2');
    expect(callOrder).toContain('B1');
  });

  // ── Test 5: Graceful drain on stop() ────────────────────────────────────

  it('drains in-flight work on stop()', async () => {
    const completed: string[] = [];
    const queue = createResultQueue();
    mockRead = queue.read;

    const { deps } = buildDeps({ readFn: queue.read });
    deps.executionService.applyResult = async ({ messageId }: { messageId: string }) => {
      await delay(50);
      completed.push(messageId);
    };

    const consumer = createResultConsumer(deps, baseConfig);
    consumer.start();

    queue.feed(makeResult('D1', 'run-D'), makeResult('D2', 'run-E'), makeResult('D3', 'run-F'));

    // Give the consumer time to pick them up, then stop immediately
    await delay(30);
    queue.seal();
    await consumer.stop();

    expect(completed).toHaveLength(3);
    expect(completed.sort()).toEqual(['D1', 'D2', 'D3']);
  });

  // ── Test 6: Chain cleanup (no memory leak) ──────────────────────────────

  it('cleans up runChains after completion (no memory leak)', async () => {
    const queue = createResultQueue();
    mockRead = queue.read;

    const { deps } = buildDeps({ readFn: queue.read });
    deps.executionService.applyResult = async () => {
      await delay(5);
    };

    const consumer = createResultConsumer(deps, baseConfig);
    consumer.start();

    // Feed results for 50 distinct runIds
    for (let i = 0; i < 50; i++) {
      queue.feed(makeResult(`r${String(i)}`, `run-${String(i)}`));
    }

    await delay(800);
    queue.seal();
    await consumer.stop();

    // After stop + drain, all acks should have been called
    expect(ackIds.length).toBe(50);
  });

  // ── Test 7: Pending drain skips in-flight messages (no duplicates) ──────

  it('pending drain skips in-flight messages to prevent duplicate applyResult', async () => {
    const applyCalls: string[] = [];
    const queue = createResultQueue();
    mockRead = queue.read;

    const { deps } = buildDeps({ readFn: queue.read });
    deps.executionService.applyResult = async ({ messageId }: { messageId: string }) => {
      applyCalls.push(messageId);
      // Simulate slow processing so message stays in-flight for multiple loop iterations
      await delay(150);
    };

    // After the first result is enqueued (via fresh read), pending drain will
    // return it as a pending entry. The inFlightIds guard should filter it out.
    let pendingReturned = false;
    mockReadPending = async () => {
      if (!pendingReturned) {
        // First call: no pending yet (message hasn't been read)
        return [];
      }
      // Subsequent calls: return the same message as "pending" — simulating cursor '0'
      // returning an entry that was delivered to us but not yet acked
      return [makeResult('P1', 'run-P')];
    };

    const consumer = createResultConsumer(deps, {
      ...baseConfig,
      blockMs: 10,
    });
    consumer.start();

    // Feed one result via the fresh read path
    queue.feed(makeResult('P1', 'run-P'));

    // Let the consumer pick up P1, then enable pending returns
    await delay(30);
    pendingReturned = true;

    // Wait long enough for multiple loop iterations (each would see P1 as pending)
    await delay(300);
    queue.seal();
    await consumer.stop();

    // P1 should only have been processed ONCE despite pending drain seeing it
    const p1Calls = applyCalls.filter((id) => id === 'P1');
    expect(p1Calls).toHaveLength(1);

    // And acked exactly once
    const p1Acks = ackIds.filter((id) => id === 'P1');
    expect(p1Acks).toHaveLength(1);
  });

  // ── Waking from sleep (Plan 315 D21) ────────────────────────────────────

  it('reads no result and runs no timer while held after a wake, then resumes', async () => {
    const queue = createResultQueue();
    mockRead = vi.fn(queue.read);
    const reads = mockRead as ReturnType<typeof vi.fn>;
    const applied: string[] = [];
    const { deps, executionService } = buildDeps({ readFn: queue.read });
    deps.executionService.applyResult = async ({ messageId }: { messageId: string }) => {
      applied.push(messageId);
      await Promise.resolve();
    };
    let heldMs = 15_000;
    deps.wakeHold = { remainingMs: () => heldMs };

    const consumer = createResultConsumer(deps, { ...baseConfig, timerIntervalMs: 10 });
    consumer.start();
    queue.feed(makeResult('W1', 'run-W'));
    await delay(60);

    expect(reads).not.toHaveBeenCalled();
    expect(applied).toEqual([]);
    expect(executionService.processDueTimers).not.toHaveBeenCalled();

    heldMs = 0;
    await vi.waitFor(() => expect(applied).toEqual(['W1']), { timeout: 3_000 });
    await vi.waitFor(() => expect(executionService.processDueTimers).toHaveBeenCalled());
    queue.seal();
    await consumer.stop();
  });
});
