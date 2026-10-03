/**
 * A claimed job given back unworked: it leaves this consumer's pending list and
 * is the next read of any consumer, carrying the same job — or, when the give
 * back fails, nothing moved at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import {
  ConsumerGroups,
  StreamKeys,
  type SessionId,
  type StepExecutionId,
  type StepJobMessage,
  type TenantId,
} from '@aflow/schemas';
import { createBlockingRedisConnection } from '../connection.js';
import { addStepJob, readStepJobs, releaseStepJob } from '../streams/jobs.js';

const STEP_TYPE = 'eval';
const TEST_DB = 14;

const JOB = {
  messageVersion: 1,
  tenantId: '00000000-0000-0000-0000-0000000000a0' as TenantId,
  sessionId: '00000000-0000-0000-0000-0000000000a2' as SessionId,
  stepExecutionId: '00000000-0000-0000-0000-0000000000a3' as StepExecutionId,
  stepId: 'step-1',
  stepType: STEP_TYPE,
  operationId: 'eval.suite.run',
  attempt: 1,
  idempotencyKey: 'release-1',
  inputRef: 'inline:e30=',
  traceId: '0af7651916cd43dd8448eb211c80319c',
  scheduledAtMs: 1_700_000_000_000,
} as unknown as StepJobMessage;

describe('releaseStepJob — a failed give back', () => {
  it('raises when the give back fails, so the job is not reported as handed back', async () => {
    const evaluated: unknown[][] = [];
    const pipeline = {
      eval: (...args: unknown[]) => {
        evaluated.push(args.slice(1, 5));
        return pipeline;
      },
      sadd: () => pipeline,
      exec: () =>
        Promise.resolve([
          [new Error('NOGROUP'), null],
          [null, 1],
        ]),
    };
    const redis = { pipeline: () => pipeline } as unknown as RedisType;

    await expect(releaseStepJob(redis, JOB, '1-0')).rejects.toThrow('NOGROUP');
    expect(evaluated).toEqual([
      [1, StreamKeys.jobStream(STEP_TYPE), ConsumerGroups.executor(STEP_TYPE), '1-0'],
    ]);
  });
});

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

describe.skipIf(!AVAILABLE)('releaseStepJob against real Redis', () => {
  const streamKey = StreamKeys.jobStream(STEP_TYPE);
  const group = ConsumerGroups.executor(STEP_TYPE);
  let redis: RedisType;

  beforeEach(async () => {
    redis = new Redis({ host: '127.0.0.1', port: 6379, db: TEST_DB });
    // Targeted cleanup — never flushdb, the database is shared with other suites.
    await redis.del(streamKey);
    await redis.xgroup('CREATE', streamKey, group, '0', 'MKSTREAM');
  });

  afterEach(async () => {
    await redis.del(streamKey);
    redis.disconnect();
  });

  it('takes the job off this consumer and hands the same job to the next reader', async () => {
    const draining = createBlockingRedisConnection('release-a', {
      host: '127.0.0.1',
      port: 6379,
      db: TEST_DB,
    });
    const next = createBlockingRedisConnection('release-b', {
      host: '127.0.0.1',
      port: 6379,
      db: TEST_DB,
    });
    try {
      await addStepJob(redis, JOB, { checkExecutorAvailable: false });
      const [claimed] = await readStepJobs(draining, STEP_TYPE, 'executor-a', { blockMs: 10 });
      expect(claimed).toBeDefined();

      await releaseStepJob(redis, claimed?.job ?? JOB, claimed?.id ?? '');

      const pending = (await redis.xpending(streamKey, group)) as [number, ...unknown[]];
      expect(pending[0]).toBe(0);
      const [handedOn, ...rest] = await readStepJobs(next, STEP_TYPE, 'executor-b', {
        blockMs: 10,
      });
      expect(rest).toEqual([]);
      expect(handedOn?.id).not.toBe(claimed?.id);
      expect(handedOn?.job).toEqual(claimed?.job);
    } finally {
      draining.disconnect();
      next.disconnect();
    }
  });

  async function claimOne(): Promise<{ id: string; job: StepJobMessage }> {
    const draining = createBlockingRedisConnection('release-a', {
      host: '127.0.0.1',
      port: 6379,
      db: TEST_DB,
    });
    try {
      await addStepJob(redis, JOB, { checkExecutorAvailable: false });
      const [claimed] = await readStepJobs(draining, STEP_TYPE, 'executor-a', { blockMs: 10 });
      if (claimed === undefined) throw new Error('nothing claimed');
      return claimed;
    } finally {
      draining.disconnect();
    }
  }

  it('leaves the job pending for the reclaim when it cannot re-enter the stream', async () => {
    const claimed = await claimOne();
    // A stream whose last id is the largest there is takes no further entry.
    await redis.xadd(streamKey, '18446744073709551615-18446744073709551615', 'filler', '1');

    await expect(releaseStepJob(redis, claimed.job, claimed.id)).rejects.toThrow();

    const pending = (await redis.xpending(streamKey, group)) as [number, ...unknown[]];
    expect(pending[0]).toBe(1);
    expect(await redis.xlen(streamKey)).toBe(2);
  });

  it('adds nothing to the stream when the job cannot be acknowledged', async () => {
    const claimed = await claimOne();
    await redis.xgroup('DESTROY', streamKey, group);

    await expect(releaseStepJob(redis, claimed.job, claimed.id)).rejects.toThrow('NOGROUP');

    expect(await redis.xlen(streamKey)).toBe(1);
  });
});
