import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createBlockingRedisConnection,
  createRedisConnection,
  getRedisConfig,
  quitRedisWithTimeout,
  type BlockingRedisConnection,
} from '../connection.js';
import type { Redis } from 'ioredis';

const TEST_TIMEOUT_MS = 30_000;
const SAMPLE_COUNT = 30;
const WARMUP_SAMPLES = 5;
const PRODUCE_INTERVAL_MS = 50;
const SLOW_BLOCK_MS = 2000;
const FAST_BLOCK_MS = 100;
const TEST_GROUP = 'plan168-isolation-test';

interface MaybeRedis {
  redis: Redis | null;
  reason?: string;
}

/**
 * Probe Redis with a short-timeout PING. Skip the suite if unreachable
 * so CI without a Redis service doesn't fail outright.
 */
async function probeRedis(): Promise<MaybeRedis> {
  let redis: Redis;
  try {
    redis = createRedisConnection({ ...getRedisConfig(), maxRetriesPerRequest: 1 });
  } catch (err) {
    return { redis: null, reason: `createRedisConnection threw: ${String(err)}` };
  }
  try {
    const pong = await Promise.race([
      redis.ping(),
      new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), 2000)),
    ]);
    if (pong === 'TIMEOUT' || pong !== 'PONG') {
      await quitRedisWithTimeout(redis, 500);
      return { redis: null, reason: `ping returned ${String(pong)}` };
    }
    return { redis };
  } catch (err) {
    await quitRedisWithTimeout(redis, 500);
    return { redis: null, reason: `ping threw: ${String(err)}` };
  }
}

async function ensureGroup(redis: Redis, stream: string): Promise<void> {
  try {
    await redis.xgroup('CREATE', stream, TEST_GROUP, '0', 'MKSTREAM');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('BUSYGROUP')) throw err;
  }
}

describe('Plan 168 — blocking connection isolation (integration)', () => {
  let probeResult: MaybeRedis;
  let setup: Redis | null = null;
  let slowConn: BlockingRedisConnection | null = null;
  let fastConn: BlockingRedisConnection | null = null;
  let producer: Redis | null = null;
  let slowStream = '';
  let fastStream = '';

  beforeAll(async () => {
    probeResult = await probeRedis();
    if (!probeResult.redis) return;
    setup = probeResult.redis;
    const runId = randomUUID().slice(0, 8);
    slowStream = `test:plan168:slow:${runId}`;
    fastStream = `test:plan168:fast:${runId}`;
    await ensureGroup(setup, slowStream);
    await ensureGroup(setup, fastStream);

    slowConn = createBlockingRedisConnection(`plan168-slow-${runId}`);
    fastConn = createBlockingRedisConnection(`plan168-fast-${runId}`);
    producer = createRedisConnection(getRedisConfig());
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (!probeResult?.redis) return;
    await Promise.allSettled([
      slowConn ? quitRedisWithTimeout(slowConn) : Promise.resolve(),
      fastConn ? quitRedisWithTimeout(fastConn) : Promise.resolve(),
      producer ? quitRedisWithTimeout(producer) : Promise.resolve(),
    ]);
    if (setup) {
      try {
        await setup.del(slowStream, fastStream);
      } catch {
        /* best-effort cleanup */
      }
      await quitRedisWithTimeout(setup);
    }
  }, TEST_TIMEOUT_MS);

  it(
    'a long-blocking slow consumer does not delay a fast consumer on a separate connection',
    async () => {
      if (!probeResult.redis || !slowConn || !fastConn || !producer) {
        // eslint-disable-next-line no-console
        console.warn(
          `[plan168] integration test skipped — Redis not reachable: ${probeResult?.reason ?? 'unknown'}`,
        );
        return;
      }

      let stop = false;
      // Slow loop — owns its socket; BLOCK 2000 ties up only this connection.
      const slowLoop = (async () => {
        while (!stop) {
          try {
            await slowConn!.xreadgroup(
              'GROUP',
              TEST_GROUP,
              'slow-consumer',
              'COUNT',
              1,
              'BLOCK',
              SLOW_BLOCK_MS,
              'STREAMS',
              slowStream,
              '>',
            );
          } catch {
            /* connection dying during teardown — ignore */
            return;
          }
        }
      })();

      const latencies: number[] = [];

      // Fast loop — owns its socket; BLOCK 100. Records wall-clock from
      // each entry's `sentAtMs` field to handler observation.
      const fastLoop = (async () => {
        while (!stop && latencies.length < SAMPLE_COUNT) {
          let result: unknown;
          try {
            result = await fastConn!.xreadgroup(
              'GROUP',
              TEST_GROUP,
              'fast-consumer',
              'COUNT',
              10,
              'BLOCK',
              FAST_BLOCK_MS,
              'STREAMS',
              fastStream,
              '>',
            );
          } catch {
            return;
          }
          if (!result) continue;
          const typed = result as Array<[string, Array<[string, string[]]>]>;
          for (const [, entries] of typed) {
            for (const [id, fields] of entries) {
              const now = Date.now();
              let sentAtMs = 0;
              for (let i = 0; i + 1 < fields.length; i += 2) {
                if (fields[i] === 'sentAtMs') {
                  sentAtMs = Number(fields[i + 1]);
                  break;
                }
              }
              if (sentAtMs > 0) latencies.push(now - sentAtMs);
              await fastConn!.xack(fastStream, TEST_GROUP, id);
            }
          }
        }
      })();

      // Producer — XADD a fast-stream entry every PRODUCE_INTERVAL_MS until
      // the fast loop has enough samples.
      const producerLoop = (async () => {
        while (!stop && latencies.length < SAMPLE_COUNT) {
          try {
            await producer!.xadd(fastStream, '*', 'sentAtMs', String(Date.now()));
          } catch {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, PRODUCE_INTERVAL_MS));
        }
      })();

      // Bound the whole experiment so a stuck Redis cannot hang CI.
      const deadline = Date.now() + 20_000;
      while (latencies.length < SAMPLE_COUNT && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      stop = true;
      await Promise.allSettled([slowLoop, fastLoop, producerLoop]);

      // Drop warm-up samples so connection-establishment lag doesn't skew
      // the percentile.
      const measured = latencies.slice(WARMUP_SAMPLES);
      expect(
        measured.length,
        `Expected ≥${String(SAMPLE_COUNT - WARMUP_SAMPLES)} samples; got ${String(measured.length)}`,
      ).toBeGreaterThanOrEqual(SAMPLE_COUNT - WARMUP_SAMPLES);

      const sorted = [...measured].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      const max = sorted[sorted.length - 1] ?? 0;

      // eslint-disable-next-line no-console
      console.info(
        `[plan168] fast-loop latency (n=${String(measured.length)}): ` +
          `p50=${String(sorted[Math.floor(sorted.length * 0.5)])}ms ` +
          `p95=${String(p95)}ms max=${String(max)}ms`,
      );

      // Gating: with dedicated connections, the fast loop's max latency
      // should be well under the slow loop's 2000ms BLOCK budget. The
      // generous thresholds survive CI jitter while still catching the
      // regression class (max approaching 2000ms == shared connection).
      expect(p95).toBeLessThan(500);
      expect(max).toBeLessThan(1000);
    },
    TEST_TIMEOUT_MS,
  );
});
