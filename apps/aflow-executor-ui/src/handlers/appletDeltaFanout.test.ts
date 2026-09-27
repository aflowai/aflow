import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import type { TenantId } from '@aflow/schemas';
import { getAttentionCache, setAttentionCache } from '@aflow/cybernetic-runtime';
import { createAppletDeltaFanout } from './appletDeltaFanout.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SPACE = randomUUID();

class FakeRedis {
  store = new Map<string, string>();
  published: Array<{ channel: string; message: string }> = [];

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }
  async setnx(key: string, value: string): Promise<number> {
    if (this.store.has(key)) return 0;
    this.store.set(key, value);
    return 1;
  }
  async incr(key: string): Promise<number> {
    const next = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(next));
    return next;
  }
  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    return 0;
  }
}

describe('createAppletDeltaFanout', () => {
  it('publishes the realtime delta and invalidates the cached attention block', async () => {
    const fake = new FakeRedis();
    const redis = fake as unknown as Redis;

    await setAttentionCache(redis, TENANT, SPACE, '{"cached":true}', null);
    expect((await getAttentionCache(redis, TENANT, SPACE)).value).toBe('{"cached":true}');

    const fanout = createAppletDeltaFanout(redis);
    const instanceId = randomUUID();
    await fanout(TENANT, SPACE, { instanceId, seq: 1, stateVersion: 2, patch: [] });

    expect((await getAttentionCache(redis, TENANT, SPACE)).value).toBeNull();
    expect(fake.published).toHaveLength(1);
    expect(fake.published[0]!.channel).toContain(instanceId);
    expect(JSON.parse(fake.published[0]!.message)).toMatchObject({ instanceId, stateVersion: 2 });
  });
});
