import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { acquireRuntimeLease, RuntimeLeaseAbortedError } from '../localRuntimeAdmission.js';

const RUNTIME = 'this-machine:11434';
let redis: RedisType;

beforeEach(async () => {
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

afterEach(() => {
  redis.disconnect();
});

const take = (
  holderId: string,
  opts: { wait?: boolean; limit?: number; signal?: AbortSignal } = {},
) =>
  acquireRuntimeLease({
    redis,
    runtimeId: RUNTIME,
    limit: opts.limit ?? 1,
    holderId,
    wait: opts.wait ?? true,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

describe('acquireRuntimeLease', () => {
  it('admits no more requests than the runtime takes', async () => {
    const a = await take('a');
    expect(a).not.toBeNull();
    expect(await take('b', { wait: false })).toBeNull();

    await a?.release();
    const b = await take('b', { wait: false });
    expect(b).not.toBeNull();
    await b?.release();
  });

  it('admits as many at once as the limit allows', async () => {
    const leases = await Promise.all([take('a', { limit: 2 }), take('b', { limit: 2 })]);
    expect(leases.every((l) => l !== null)).toBe(true);
    expect(await take('c', { limit: 2, wait: false })).toBeNull();
    await Promise.all(leases.map((l) => l?.release()));
  });

  it('serves waiters in the order they arrived', async () => {
    const a = await take('a');
    const order: string[] = [];
    const b = take('b').then((lease) => {
      order.push('b');
      return lease;
    });
    await new Promise((r) => setTimeout(r, 20));
    const c = take('c').then((lease) => {
      order.push('c');
      return lease;
    });
    await new Promise((r) => setTimeout(r, 20));

    await a?.release();
    const bLease = await b;
    expect(order).toEqual(['b']);
    await bLease?.release();
    const cLease = await c;
    expect(order).toEqual(['b', 'c']);
    await cLease?.release();
  }, 10_000);

  it('a cancelled wait leaves the queue, so the next waiter is not held behind it', async () => {
    const a = await take('a');
    const controller = new AbortController();
    const b = take('b', { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    const c = take('c');
    await new Promise((r) => setTimeout(r, 20));

    controller.abort();
    await expect(b).rejects.toBeInstanceOf(RuntimeLeaseAbortedError);
    await a?.release();
    const cLease = await c;
    expect(cLease).not.toBeNull();
    await cLease?.release();
  }, 10_000);

  it('a holder that stopped renewing frees its place without a sweep', async () => {
    // A worker killed while holding a lease leaves an entry that expired.
    await redis.zadd(`aflow:local-runtime:{${RUNTIME}}:holders`, Date.now() - 1, 'dead-worker');
    const lease = await take('b', { wait: false });
    expect(lease).not.toBeNull();
    await lease?.release();
  });

  it('two names for this machine share one runtime', async () => {
    const a = await acquireRuntimeLease({
      redis,
      runtimeId: RUNTIME,
      limit: 1,
      holderId: 'a',
      wait: true,
    });
    const sameRuntime = await acquireRuntimeLease({
      redis,
      runtimeId: RUNTIME,
      limit: 1,
      holderId: 'b',
      wait: false,
    });
    const otherRuntime = await acquireRuntimeLease({
      redis,
      runtimeId: 'gpu-box:11434',
      limit: 1,
      holderId: 'c',
      wait: false,
    });
    expect(sameRuntime).toBeNull();
    expect(otherRuntime).not.toBeNull();
    await a?.release();
    await otherRuntime?.release();
  });
});
