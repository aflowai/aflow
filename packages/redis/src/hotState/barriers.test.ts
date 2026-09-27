import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import {
  registerBarrierWatchdog,
  removeBarrierWatchdog,
  peekStaleBarriers,
  claimBarrier,
  refreshBarrier,
  dropBarrier,
} from './barriers.js';

/** Minimal in-memory ZSET implementing only the commands barriers.ts uses. */
function createFakeRedis(): { redis: Redis; store: Map<string, number> } {
  const store = new Map<string, number>();
  const redis = {
    zadd(_key: string, ...args: Array<string | number>): Promise<number> {
      let i = 0;
      let xx = false;
      let nx = false;
      while (
        typeof args[i] === 'string' &&
        ['XX', 'NX', 'GT', 'LT', 'CH'].includes(args[i] as string)
      ) {
        if (args[i] === 'XX') xx = true;
        if (args[i] === 'NX') nx = true;
        i++;
      }
      let added = 0;
      for (; i + 1 < args.length; i += 2) {
        const score = Number(args[i]);
        const member = String(args[i + 1]);
        const exists = store.has(member);
        if (xx && !exists) continue;
        if (nx && exists) continue;
        if (!exists) added++;
        store.set(member, score);
      }
      return Promise.resolve(added);
    },
    zrem(_key: string, ...members: string[]): Promise<number> {
      let removed = 0;
      for (const m of members) if (store.delete(m)) removed++;
      return Promise.resolve(removed);
    },
    zrangebyscore(
      _key: string,
      min: string | number,
      max: string | number,
      ...opts: Array<string | number>
    ): Promise<string[]> {
      const lo = min === '-inf' ? -Infinity : Number(min);
      const hi = max === '+inf' ? Infinity : Number(max);
      let withScores = false;
      let offset = 0;
      let count = Infinity;
      for (let i = 0; i < opts.length; i++) {
        if (opts[i] === 'WITHSCORES') withScores = true;
        else if (opts[i] === 'LIMIT') {
          offset = Number(opts[i + 1]);
          count = Number(opts[i + 2]);
          i += 2;
        }
      }
      const rows = [...store.entries()]
        .filter(([, s]) => s >= lo && s <= hi)
        .sort((a, b) => a[1] - b[1])
        .slice(offset, offset + count);
      const out: string[] = [];
      for (const [member, score] of rows) {
        out.push(member);
        if (withScores) out.push(String(score));
      }
      return Promise.resolve(out);
    },
  };
  return { redis: redis as unknown as Redis, store };
}

const TENANT = 'tenant-1';
const RUN = '00000000-0000-0000-0000-000000000001';
const AGENT = 'agent';
const MEMBER = JSON.stringify({ tenantId: TENANT, runId: RUN, agentStepId: AGENT });

describe('barriers ZSET ops', () => {
  it('peekStaleBarriers returns stale entries with member + score, without removing them', async () => {
    const { redis, store } = createFakeRedis();
    const created = Date.now() - 200_000;
    await registerBarrierWatchdog(redis, TENANT, RUN, AGENT, created);

    const stale = await peekStaleBarriers(redis, 120_000);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.entry).toEqual({ tenantId: TENANT, runId: RUN, agentStepId: AGENT });
    expect(stale[0]?.member).toBe(MEMBER);
    expect(stale[0]?.score).toBe(created);
    // Non-destructive: still present after peek.
    expect(store.has(MEMBER)).toBe(true);
  });

  it('peekStaleBarriers excludes entries younger than maxAge', async () => {
    const { redis } = createFakeRedis();
    await registerBarrierWatchdog(redis, TENANT, RUN, AGENT, Date.now() - 1_000);
    const stale = await peekStaleBarriers(redis, 120_000);
    expect(stale).toHaveLength(0);
  });

  it('claimBarrier removes the member and returns true exactly once', async () => {
    const { redis } = createFakeRedis();
    await registerBarrierWatchdog(redis, TENANT, RUN, AGENT, Date.now() - 200_000);

    const first = await claimBarrier(redis, MEMBER);
    const second = await claimBarrier(redis, MEMBER);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('refreshBarrier (ZADD XX) updates an existing score', async () => {
    const { redis, store } = createFakeRedis();
    await registerBarrierWatchdog(redis, TENANT, RUN, AGENT, 1_000);
    await refreshBarrier(redis, MEMBER, 9_000);
    expect(store.get(MEMBER)).toBe(9_000);
  });

  it('refreshBarrier does NOT re-add a member that was already removed', async () => {
    const { redis, store } = createFakeRedis();
    await registerBarrierWatchdog(redis, TENANT, RUN, AGENT, 1_000);
    await dropBarrier(redis, MEMBER);
    expect(store.has(MEMBER)).toBe(false);

    // Simulates the waiter completing between peek and refresh: XX is a no-op.
    await refreshBarrier(redis, MEMBER, Date.now());
    expect(store.has(MEMBER)).toBe(false);
  });

  it('dropBarrier and removeBarrierWatchdog both remove the member', async () => {
    const { redis, store } = createFakeRedis();
    await registerBarrierWatchdog(redis, TENANT, RUN, AGENT, 1_000);
    await dropBarrier(redis, MEMBER);
    expect(store.has(MEMBER)).toBe(false);

    await registerBarrierWatchdog(redis, TENANT, RUN, AGENT, 1_000);
    await removeBarrierWatchdog(redis, TENANT, RUN, AGENT);
    expect(store.has(MEMBER)).toBe(false);
  });
});
