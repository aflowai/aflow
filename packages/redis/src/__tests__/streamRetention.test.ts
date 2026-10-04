/**
 * Retention on the transport streams.
 *
 * The load-bearing property is not that entries get removed — it is that
 * undelivered ones never do. A job sitting in a stream whose executor is down is
 * a backlog, not garbage, and a retention rule that cannot tell the difference
 * deletes work on exactly the incident where the platform is already degraded.
 * Every case below is written against that direction.
 *
 * The frontier arithmetic runs against a stub so it is covered wherever the
 * suite runs; the semantics that only Redis defines — what XPENDING reports
 * after a partial ack, what XTRIM MINID actually removes — run against real
 * Redis on their own database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { stackRedis } from '../testing/stackRedis.js';
import {
  StreamKeys,
  ConsumerGroups,
  type SessionId,
  type StepExecutionId,
  type TenantId,
} from '@aflow/schemas';
import {
  armRetentionCandidate,
  claimRetentionCandidates,
  computeAckedFrontier,
  execAckPipeline,
  peekRetentionCandidates,
  rearmRetentionCandidates,
  trimToAckedFrontier,
} from '../streams/retention.js';
import { ackStepJob, addStepJob } from '../streams/jobs.js';
import { cleanupStaleConsumers } from '../streams/hygiene.js';

// ---------------------------------------------------------------------------
// Frontier arithmetic — stubbed, always runs
// ---------------------------------------------------------------------------

interface StubGroup {
  name: string;
  pending: number;
  lastDeliveredId: string;
  oldestPendingId?: string | null;
}

function stubRedis(options: {
  groups?: StubGroup[] | 'missing';
  length?: number;
  xinfoError?: Error;
  xpendingError?: Error;
  xtrimError?: Error;
  oldestId?: string;
}): {
  redis: RedisType;
  trims: Array<{ key: string; minId: string }>;
} {
  const trims: Array<{ key: string; minId: string }> = [];
  const groups = options.groups ?? [];
  const redis = {
    xinfo: (_sub: string, key: string) => {
      if (options.xinfoError) return Promise.reject(options.xinfoError);
      if (groups === 'missing') return Promise.reject(new Error('ERR no such key'));
      return Promise.resolve(
        groups.map((g) => [
          'name',
          g.name,
          'consumers',
          1,
          'pending',
          g.pending,
          'last-delivered-id',
          g.lastDeliveredId,
        ]),
      );
    },
    xpending: (_key: string, groupName: string) => {
      if (options.xpendingError) return Promise.reject(options.xpendingError);
      if (groups === 'missing') return Promise.resolve(null);
      const group = groups.find((g) => g.name === groupName);
      const oldest = group?.oldestPendingId;
      if (oldest === undefined || oldest === null) return Promise.resolve(null);
      return Promise.resolve([group?.pending ?? 0, oldest, oldest, []]);
    },
    xlen: () => Promise.resolve(options.length ?? 0),
    pipeline: () => {
      let trimming = false;
      const chain = {
        xtrim: (key: string, _mode: string, minId: string) => {
          trims.push({ key, minId });
          trimming = true;
          return chain;
        },
        xlen: () => chain,
        xrange: () => chain,
        exec: () => {
          const oldest = options.oldestId === undefined ? [] : [[options.oldestId, ['n', '0']]];
          const tail: Array<[Error | null, unknown]> = [
            [null, options.length ?? 0],
            [null, oldest],
          ];
          return Promise.resolve(
            trimming
              ? [[options.xtrimError ?? null, options.xtrimError ? null : 1], ...tail]
              : tail,
          );
        },
      };
      return chain;
    },
  } as unknown as RedisType;
  return { redis, trims };
}

describe('acked frontier', () => {
  it('advances past the last delivered id when a group has drained', async () => {
    const { redis } = stubRedis({
      groups: [{ name: 'g1', pending: 0, lastDeliveredId: '100-0' }],
    });
    expect(await computeAckedFrontier(redis, 'aflow:jobs:ai')).toBe('100-1');
  });

  it('pins to the oldest unacked entry when a group has pending work', async () => {
    const { redis } = stubRedis({
      groups: [{ name: 'g1', pending: 3, lastDeliveredId: '100-0', oldestPendingId: '42-0' }],
    });
    expect(await computeAckedFrontier(redis, 'aflow:jobs:ai')).toBe('42-0');
  });

  it('takes the minimum across groups, so the slowest one holds the line', async () => {
    const { redis } = stubRedis({
      groups: [
        { name: 'fast', pending: 0, lastDeliveredId: '900-0' },
        { name: 'slow', pending: 1, lastDeliveredId: '900-0', oldestPendingId: '7-0' },
      ],
    });
    expect(await computeAckedFrontier(redis, 'aflow:jobs:ai')).toBe('7-0');
  });

  it('orders ids by sequence, not lexically', async () => {
    const { redis } = stubRedis({
      groups: [
        { name: 'a', pending: 0, lastDeliveredId: '10-9' },
        { name: 'b', pending: 0, lastDeliveredId: '9-0' },
      ],
    });
    // Lexically '10-9' < '9-0'; numerically it is the later id.
    expect(await computeAckedFrontier(redis, 'aflow:jobs:ai')).toBe('9-1');
  });

  it('falls back to the last delivered id when a group drains mid-computation', async () => {
    // pending was nonzero at XINFO but XPENDING now reports nothing: the stale
    // last-delivered-id trims less than the stream now could, which is safe.
    const { redis } = stubRedis({
      groups: [{ name: 'g1', pending: 2, lastDeliveredId: '55-0', oldestPendingId: null }],
    });
    expect(await computeAckedFrontier(redis, 'aflow:jobs:ai')).toBe('55-1');
  });

  it('refuses to trim a stream carrying no consumer group', async () => {
    const { redis, trims } = stubRedis({ groups: [], length: 12 });
    const result = await trimToAckedFrontier(redis, 'aflow:jobs:ai');
    expect(result.frontier).toBeNull();
    expect(result.trimmed).toBe(0);
    expect(result.retained).toBe(12);
    expect(trims).toEqual([]);
  });

  it('refuses to trim a stream that no longer exists', async () => {
    const { redis, trims } = stubRedis({ groups: 'missing' });
    const result = await trimToAckedFrontier(redis, 'aflow:jobs:gone');
    expect(result.frontier).toBeNull();
    expect(trims).toEqual([]);
  });

  it('computes but does not trim in dry-run mode', async () => {
    const { redis, trims } = stubRedis({
      groups: [{ name: 'g1', pending: 0, lastDeliveredId: '100-0' }],
      length: 5,
    });
    const result = await trimToAckedFrontier(redis, 'aflow:jobs:ai', { dryRun: true });
    expect(result.frontier).toBe('100-1');
    expect(result.trimmed).toBe(0);
    expect(trims).toEqual([]);
  });
});

describe('oldest-retained age — the abandoned-group signal', () => {
  it('measures the age of the oldest surviving entry', async () => {
    const tenMinutesAgo = Date.now() - 600_000;
    const { redis } = stubRedis({
      groups: [{ name: 'g1', pending: 1, lastDeliveredId: '1-0', oldestPendingId: '1-0' }],
      length: 3,
      oldestId: `${tenMinutesAgo}-0`,
    });

    const result = await trimToAckedFrontier(redis, 'aflow:jobs:ai');

    expect(result.oldestRetainedAgeMs).toBeGreaterThanOrEqual(600_000);
    expect(result.oldestRetainedAgeMs).toBeLessThan(700_000);
  });

  it('reports no age when the stream holds nothing', async () => {
    const { redis } = stubRedis({
      groups: [{ name: 'g1', pending: 0, lastDeliveredId: '100-0' }],
      length: 0,
    });

    const result = await trimToAckedFrontier(redis, 'aflow:jobs:ai');

    expect(result.retained).toBe(0);
    expect(result.oldestRetainedAgeMs).toBeNull();
  });
});

describe('error handling never trims on an uncertain read', () => {
  it('propagates an XPENDING failure instead of reading it as a drained group', async () => {
    // The dangerous shape: XINFO said pending > 0, so falling back to
    // next(lastDeliveredId) here would delete entries that are still unacked.
    const { redis, trims } = stubRedis({
      groups: [{ name: 'g1', pending: 4, lastDeliveredId: '900-0', oldestPendingId: '5-0' }],
      xpendingError: new Error('ETIMEDOUT'),
    });
    await expect(trimToAckedFrontier(redis, 'aflow:jobs:ai')).rejects.toThrow('ETIMEDOUT');
    expect(trims).toEqual([]);
  });

  it('propagates an XINFO failure that is not a missing key', async () => {
    const { redis, trims } = stubRedis({ xinfoError: new Error('NOPERM') });
    await expect(trimToAckedFrontier(redis, 'aflow:jobs:ai')).rejects.toThrow('NOPERM');
    expect(trims).toEqual([]);
  });

  it('still treats a missing key as nothing to do', async () => {
    const { redis } = stubRedis({ groups: 'missing' });
    await expect(computeAckedFrontier(redis, 'aflow:jobs:gone')).resolves.toBeNull();
  });

  it('raises a failed XTRIM rather than reporting it as an empty trim', async () => {
    const { redis } = stubRedis({
      groups: [{ name: 'g1', pending: 0, lastDeliveredId: '100-0' }],
      xtrimError: new Error('OOM command not allowed'),
    });
    await expect(trimToAckedFrontier(redis, 'aflow:jobs:ai')).rejects.toThrow('OOM');
  });
});

describe('ack pipeline error handling', () => {
  function pipelineReturning(replies: Array<[Error | null, unknown]>) {
    return { exec: () => Promise.resolve(replies) } as unknown as Parameters<
      typeof execAckPipeline
    >[0];
  }

  it('raises an ack failure that the pipeline reply would otherwise hide', async () => {
    const boom = new Error('NOGROUP');
    await expect(execAckPipeline(pipelineReturning([[boom, null]]), 1)).rejects.toThrow('NOGROUP');
  });

  it('ignores a failed arm, since the next ack re-arms the stream', async () => {
    const replies: Array<[Error | null, unknown]> = [
      [null, 1],
      [new Error('OOM'), null],
    ];
    await expect(execAckPipeline(pipelineReturning(replies), 1)).resolves.toBeUndefined();
  });

  it('checks every ack in a batch, not just the first', async () => {
    const replies: Array<[Error | null, unknown]> = [
      [null, 1],
      [new Error('NOGROUP'), null],
      [null, 1],
    ];
    await expect(execAckPipeline(pipelineReturning(replies), 3)).rejects.toThrow('NOGROUP');
  });
});

// ---------------------------------------------------------------------------
// Stream semantics — real Redis
// ---------------------------------------------------------------------------

const TEST_DB = 14;

const STACK_REDIS = await stackRedis(TEST_DB);

const STREAM = 'aflow:jobs:retention-test';
const GROUP = 'exec_retention_test';

describe.skipIf(!STACK_REDIS.available)('retention against real Redis', () => {
  let redis: RedisType;

  beforeEach(async () => {
    redis = new Redis(STACK_REDIS.url);
    // Targeted cleanup — never flushdb, the database is shared with other suites.
    await redis.del(STREAM, StreamKeys.retentionCandidateSet);
    await redis.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
  });

  afterEach(async () => {
    await redis.del(STREAM, StreamKeys.retentionCandidateSet);
    redis.disconnect();
  });

  async function produce(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = await redis.xadd(STREAM, '*', 'n', String(i));
      if (id !== null) ids.push(id);
    }
    return ids;
  }

  it('NEVER trims an entry that was never delivered', async () => {
    await produce(5);
    const result = await trimToAckedFrontier(redis, STREAM);
    expect(result.trimmed).toBe(0);
    expect(await redis.xlen(STREAM)).toBe(5);
  });

  it('NEVER trims delivered-but-unacked entries when their consumer died', async () => {
    await produce(5);
    await redis.xreadgroup('GROUP', GROUP, 'c1', 'COUNT', 5, 'STREAMS', STREAM, '>');
    // A crashed executor leaves its consumer and PEL in place — that is what
    // makes the entries reclaimable by XAUTOCLAIM, and what must pin the frontier.
    const result = await trimToAckedFrontier(redis, STREAM);

    expect(result.trimmed).toBe(0);
    expect(await redis.xlen(STREAM)).toBe(5);
  });

  it('still pins the frontier after the entries are reclaimed by another consumer', async () => {
    await produce(3);
    await redis.xreadgroup('GROUP', GROUP, 'c1', 'COUNT', 3, 'STREAMS', STREAM, '>');
    await redis.xautoclaim(STREAM, GROUP, 'c2', 0, '0');

    const result = await trimToAckedFrontier(redis, STREAM);
    expect(result.trimmed).toBe(0);
    expect(await redis.xlen(STREAM)).toBe(3);
  });

  /**
   * DELCONSUMER drops that consumer's pending entries outright — the group's
   * pending count falls to zero and its last-delivered-id stays ahead of them, so
   * Redis will never redeliver them and retention will reclaim them. That makes
   * `cleanupStaleConsumers`' zero-pending guard load-bearing for this plan's
   * invariant, not merely tidy, so both halves are pinned here.
   */
  it('treats a consumer deleted while holding pending entries as work Redis already dropped', async () => {
    await produce(5);
    await redis.xreadgroup('GROUP', GROUP, 'c1', 'COUNT', 5, 'STREAMS', STREAM, '>');
    await redis.xgroup('DELCONSUMER', STREAM, GROUP, 'c1');

    const result = await trimToAckedFrontier(redis, STREAM);
    expect(result.trimmed).toBe(5);
  });

  it('never lets consumer hygiene delete a consumer that still holds pending entries', async () => {
    // Must be a stream cleanupStaleConsumers actually visits: it walks keys built
    // from EXECUTOR_JOB_STEP_TYPES, so a test-only stream name would make the
    // zero-removal assertion pass even with the guard deleted.
    const enumerated = StreamKeys.jobStream('eval');
    const enumeratedGroup = ConsumerGroups.executor('eval');
    await redis.del(enumerated);
    await redis.xgroup('CREATE', enumerated, enumeratedGroup, '0', 'MKSTREAM');
    try {
      for (let i = 0; i < 4; i++) await redis.xadd(enumerated, '*', 'n', String(i));
      await redis.xreadgroup(
        'GROUP',
        enumeratedGroup,
        'c1',
        'COUNT',
        4,
        'STREAMS',
        enumerated,
        '>',
      );

      // maxIdleMs 0 makes every consumer idle enough; only the pending guard is left.
      const cleanup = await cleanupStaleConsumers(redis, 0);
      expect(cleanup.streamsChecked).toBeGreaterThan(0);
      expect(cleanup.consumersRemoved).toBe(0);

      // The consumer survived, so its PEL still pins the frontier.
      const result = await trimToAckedFrontier(redis, enumerated);
      expect(result.trimmed).toBe(0);
      expect(await redis.xlen(enumerated)).toBe(4);
    } finally {
      await redis.del(enumerated);
    }
  });

  it('does let hygiene reap a consumer that holds nothing, leaving the stream trimmable', async () => {
    const enumerated = StreamKeys.jobStream('eval');
    const enumeratedGroup = ConsumerGroups.executor('eval');
    await redis.del(enumerated);
    await redis.xgroup('CREATE', enumerated, enumeratedGroup, '0', 'MKSTREAM');
    try {
      const id = await redis.xadd(enumerated, '*', 'n', '0');
      await redis.xreadgroup(
        'GROUP',
        enumeratedGroup,
        'c1',
        'COUNT',
        1,
        'STREAMS',
        enumerated,
        '>',
      );
      await redis.xack(enumerated, enumeratedGroup, id!);

      // -1, not 0: hygiene reaps on `idle > maxIdleMs`, and a consumer created in
      // the same millisecond reports idle 0 — so a threshold of 0 reaps nothing on
      // a machine fast enough to get here inside one tick, and the test fails for
      // being quick. -1 is what "however briefly it has been idle" spells.
      const cleanup = await cleanupStaleConsumers(redis, -1);
      expect(cleanup.consumersRemoved).toBeGreaterThan(0);

      const result = await trimToAckedFrontier(redis, enumerated);
      expect(result.trimmed).toBe(1);
    } finally {
      await redis.del(enumerated);
    }
  });

  it('arms a candidate when a job is enqueued, not only when one is acked', async () => {
    await redis.del(StreamKeys.retentionCandidateSet);
    const jobStream = StreamKeys.jobStream('eval');
    await redis.del(jobStream);
    try {
      await addStepJob(
        redis,
        {
          tenantId: '00000000-0000-0000-0000-0000000000f0' as TenantId,
          sessionId: '00000000-0000-0000-0000-0000000000f2' as SessionId,
          stepExecutionId: '00000000-0000-0000-0000-0000000000f3' as StepExecutionId,
          stepId: 'step-1',
          stepType: 'eval',
          operationId: 'eval.suite.run',
          attempt: 1,
          idempotencyKey: 'retention-enqueue-1',
          inputRef: 'inline:e30=',
          traceId: '0af7651916cd43dd8448eb211c80319c',
          scheduledAtMs: 1_700_000_000_000,
        } as never,
        { checkExecutorAvailable: false },
      );

      expect(await redis.sismember(StreamKeys.retentionCandidateSet, jobStream)).toBe(1);
    } finally {
      await redis.del(jobStream, StreamKeys.retentionCandidateSet);
    }
  });

  it('reads candidates without consuming them when peeking', async () => {
    const pipeline = redis.pipeline();
    for (let i = 0; i < 3; i++) armRetentionCandidate(pipeline, `aflow:jobs:peek-${i}`);
    await pipeline.exec();

    expect(await peekRetentionCandidates(redis, 10)).toHaveLength(3);
    // Still all there — observe must not drain the set it observes.
    expect(await peekRetentionCandidates(redis, 10)).toHaveLength(3);
    expect(await redis.scard(StreamKeys.retentionCandidateSet)).toBe(3);
  });

  it('restores re-armed candidates to the set', async () => {
    await rearmRetentionCandidates(redis, ['aflow:jobs:a', 'aflow:jobs:b']);
    expect(await redis.scard(StreamKeys.retentionCandidateSet)).toBe(2);
    await rearmRetentionCandidates(redis, []);
    expect(await redis.scard(StreamKeys.retentionCandidateSet)).toBe(2);
  });

  it('reclaims the whole stream once every entry is delivered and acked', async () => {
    const ids = await produce(5);
    await redis.xreadgroup('GROUP', GROUP, 'c1', 'COUNT', 5, 'STREAMS', STREAM, '>');
    for (const id of ids) await redis.xack(STREAM, GROUP, id);

    const result = await trimToAckedFrontier(redis, STREAM);
    expect(result.trimmed).toBe(5);
    expect(result.retained).toBe(0);
    expect(await redis.xlen(STREAM)).toBe(0);
  });

  it('reclaims only the acked prefix when a later entry is still pending', async () => {
    const ids = await produce(4);
    await redis.xreadgroup('GROUP', GROUP, 'c1', 'COUNT', 4, 'STREAMS', STREAM, '>');
    await redis.xack(STREAM, GROUP, ids[0]!);
    await redis.xack(STREAM, GROUP, ids[1]!);

    const result = await trimToAckedFrontier(redis, STREAM);
    expect(result.trimmed).toBe(2);
    expect(await redis.xlen(STREAM)).toBe(2);
  });

  it('holds the line at the slowest of two consumer groups', async () => {
    const second = 'exec_retention_test_b';
    await redis.xgroup('CREATE', STREAM, second, '0');
    const ids = await produce(3);

    await redis.xreadgroup('GROUP', GROUP, 'c1', 'COUNT', 3, 'STREAMS', STREAM, '>');
    for (const id of ids) await redis.xack(STREAM, GROUP, id);
    // The second group has not read anything at all.

    const result = await trimToAckedFrontier(redis, STREAM);
    expect(result.trimmed).toBe(0);
    expect(await redis.xlen(STREAM)).toBe(3);
  });

  it('arms a candidate on ack and hands it back exactly once', async () => {
    const ids = await produce(1);
    await redis.xreadgroup('GROUP', GROUP, 'c1', 'COUNT', 1, 'STREAMS', STREAM, '>');
    await ackStepJob(redis, 'ai', ids[0]!, { streamKey: STREAM, consumerGroup: GROUP });

    expect(await redis.sismember(StreamKeys.retentionCandidateSet, STREAM)).toBe(1);
    expect(await claimRetentionCandidates(redis, 10)).toEqual([STREAM]);
    expect(await claimRetentionCandidates(redis, 10)).toEqual([]);
  });

  it('bounds a claim to the requested batch', async () => {
    const pipeline = redis.pipeline();
    for (let i = 0; i < 5; i++) armRetentionCandidate(pipeline, `aflow:jobs:fake-${i}`);
    await pipeline.exec();

    expect(await claimRetentionCandidates(redis, 2)).toHaveLength(2);
    expect(await claimRetentionCandidates(redis, 99)).toHaveLength(3);
  });

  it('leaves a fresh group with nothing delivered untouched', async () => {
    await produce(3);
    // last-delivered-id is 0-0; the frontier must not remove real entries.
    const result = await trimToAckedFrontier(redis, STREAM);
    expect(result.frontier).toBe('0-1');
    expect(await redis.xlen(STREAM)).toBe(3);
  });

  it('reports a real age for entries a group has not finished with', async () => {
    await produce(3);
    await redis.xreadgroup('GROUP', GROUP, 'c1', 'COUNT', 3, 'STREAMS', STREAM, '>');

    const result = await trimToAckedFrontier(redis, STREAM);

    // Nothing acked, so nothing trimmed — and the entries now have a measurable
    // age that climbs for as long as the group stays stuck.
    expect(result.trimmed).toBe(0);
    expect(result.retained).toBe(3);
    expect(result.oldestRetainedAgeMs).not.toBeNull();
    expect(result.oldestRetainedAgeMs!).toBeLessThan(60_000);
  });

  it('drops the age back to null once the stream drains', async () => {
    const ids = await produce(2);
    await redis.xreadgroup('GROUP', GROUP, 'c1', 'COUNT', 2, 'STREAMS', STREAM, '>');
    for (const id of ids) await redis.xack(STREAM, GROUP, id);

    const result = await trimToAckedFrontier(redis, STREAM);

    // The current-state property the metric depends on: a drained stream reports
    // no age at all rather than keeping the last one it had.
    expect(result.retained).toBe(0);
    expect(result.oldestRetainedAgeMs).toBeNull();
  });

  it('keeps the executor consumer-group naming contract', () => {
    expect(ConsumerGroups.executor('ai')).toBe('exec_ai');
    expect(StreamKeys.jobStream('ai')).toBe('aflow:jobs:ai');
  });
});
