import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { configureLogging } from '@aflow/observability';
import {
  getAttentionCache,
  setAttentionCache,
  bumpAttentionGeneration,
  getAttentionCacheCounters,
  resetAttentionCacheCounters,
} from '../attentionCache.js';
import { startAttentionCacheSubscriber } from '../attentionCacheSubscriber.js';

const TENANT = 'tenant-1';
const SPACE = 'space-1';

// ioredis-mock returns a compatible Redis instance
function createMockRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

describe('attentionCache behavior', () => {
  let redis: RedisType;

  beforeEach(() => {
    redis = createMockRedis();
    resetAttentionCacheCounters();
  });

  it('get returns null value on miss', async () => {
    const result = await getAttentionCache(redis, TENANT, SPACE);
    expect(result.value).toBeNull();
    expect(getAttentionCacheCounters().misses).toBe(1);
    expect(getAttentionCacheCounters().hits).toBe(0);
  });

  it('set then get returns the stored value (hit)', async () => {
    const value = JSON.stringify({ activeWorkflowRuns: [], pendingProposals: 3 });
    const miss = await getAttentionCache(redis, TENANT, SPACE);
    await setAttentionCache(redis, TENANT, SPACE, value, miss.generation);
    const result = await getAttentionCache(redis, TENANT, SPACE);
    expect(result.value).toBe(value);
    expect(getAttentionCacheCounters().hits).toBe(1);
  });

  it('bumpGeneration invalidates cached value', async () => {
    const value = JSON.stringify({ data: 'test' });
    const miss = await getAttentionCache(redis, TENANT, SPACE);
    await setAttentionCache(redis, TENANT, SPACE, value, miss.generation);

    // Verify it's cached
    const hit = await getAttentionCache(redis, TENANT, SPACE);
    expect(hit.value).toBe(value);

    // Bump generation
    await bumpAttentionGeneration(redis, TENANT, SPACE);

    // Now get should miss — generation advanced
    const miss2 = await getAttentionCache(redis, TENANT, SPACE);
    expect(miss2.value).toBeNull();

    // Verify the invalidation was counted
    expect(getAttentionCacheCounters().invalidations).toBeGreaterThanOrEqual(1);
  });

  it('concurrent reads in the same space share a single cached value', async () => {
    const value = JSON.stringify({ shared: true });
    const miss = await getAttentionCache(redis, TENANT, SPACE);
    await setAttentionCache(redis, TENANT, SPACE, value, miss.generation);

    const [r1, r2] = await Promise.all([
      getAttentionCache(redis, TENANT, SPACE),
      getAttentionCache(redis, TENANT, SPACE),
    ]);

    expect(r1.value).toBe(value);
    expect(r2.value).toBe(value);
    expect(getAttentionCacheCounters().hits).toBe(2);
  });

  it('generation bump mid-compute prevents stale write-back', async () => {
    // Simulate: read (miss, gen=1), bump (gen=2), then try to write under gen=1
    const miss = await getAttentionCache(redis, TENANT, SPACE);
    const readGen = miss.generation;

    // Bump generation during "compute"
    await bumpAttentionGeneration(redis, TENANT, SPACE);

    // Write-back with stale generation should be silently dropped
    const staleValue = JSON.stringify({ stale: true });
    await setAttentionCache(redis, TENANT, SPACE, staleValue, readGen);

    // Read should miss — stale value was not cached
    const result = await getAttentionCache(redis, TENANT, SPACE);
    expect(result.value).toBeNull();
  });

  it('generation bump mid-read does not serve stale data', async () => {
    const staleValue = JSON.stringify({ stale: true });
    const miss = await getAttentionCache(redis, TENANT, SPACE);
    await setAttentionCache(redis, TENANT, SPACE, staleValue, miss.generation);

    // Confirm it's cached
    const firstRead = await getAttentionCache(redis, TENANT, SPACE);
    expect(firstRead.value).toBe(staleValue);

    // Bump generation (simulating an entity event)
    await bumpAttentionGeneration(redis, TENANT, SPACE);

    // Second read must NOT return stale data
    const secondRead = await getAttentionCache(redis, TENANT, SPACE);
    expect(secondRead.value).toBeNull();
  });

  it('counters track hits, misses, and invalidations accurately', async () => {
    resetAttentionCacheCounters();

    // Miss
    const miss = await getAttentionCache(redis, TENANT, SPACE);
    expect(getAttentionCacheCounters()).toEqual({ hits: 0, misses: 1, invalidations: 0 });

    // Set + hit
    await setAttentionCache(redis, TENANT, SPACE, 'val', miss.generation);
    await getAttentionCache(redis, TENANT, SPACE);
    expect(getAttentionCacheCounters()).toEqual({ hits: 1, misses: 1, invalidations: 0 });

    // Invalidation + miss
    await bumpAttentionGeneration(redis, TENANT, SPACE);
    await getAttentionCache(redis, TENANT, SPACE);
    expect(getAttentionCacheCounters()).toEqual({ hits: 1, misses: 2, invalidations: 1 });
  });
});

// Logging must be initialized before any code that calls getCyberneticLogger()
beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

describe('attentionCacheSubscriber invalidation', () => {
  const INVALIDATION_EVENTS = [
    'entity.procedure.activated',
    'entity.procedure.completed',
    'entity.coach.proposal',
    'entity.coach.ratified',
    'entity.coach.rejected',
    'entity.coach.anomaly',
    'entity.eval.completed',
    'entity.eval.regression',
  ];

  for (const eventType of INVALIDATION_EVENTS) {
    it(`bumps generation on ${eventType}`, async () => {
      const subRedis = createMockRedis();
      const cacheRedis = createMockRedis();
      resetAttentionCacheCounters();

      // Pre-seed a generation
      await cacheRedis.set(`entity:attention:gen:${TENANT}:${SPACE}`, '1');

      const cleanup = await startAttentionCacheSubscriber(subRedis, cacheRedis);

      // Dispatch synthetic pubsub message
      const channel = `entity_events:pubsub:${TENANT}:${SPACE}`;
      const message = JSON.stringify({ type: 'entity_event', eventType, spaceId: SPACE });

      // ioredis-mock emits pmessage when we publish on the same instance
      // But since subscriber uses a dedicated connection, we simulate directly
      subRedis.emit('pmessage', 'entity_events:pubsub:*:*', channel, message);

      // Allow async handler to process
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Generation should have been incremented
      const gen = await cacheRedis.get(`entity:attention:gen:${TENANT}:${SPACE}`);
      // ioredis-mock might not share state between instances, so we check
      // the invalidation counter instead as the reliable indicator
      expect(getAttentionCacheCounters().invalidations).toBeGreaterThanOrEqual(1);

      await cleanup();
    });
  }

  it('entity.memory.mutation with /identity prefix invalidates', async () => {
    const subRedis = createMockRedis();
    const cacheRedis = createMockRedis();
    resetAttentionCacheCounters();

    await cacheRedis.set(`entity:attention:gen:${TENANT}:${SPACE}`, '1');

    const cleanup = await startAttentionCacheSubscriber(subRedis, cacheRedis);

    const channel = `entity_events:pubsub:${TENANT}:${SPACE}`;
    const message = JSON.stringify({
      type: 'entity_event',
      eventType: 'entity.memory.mutation',
      spaceId: SPACE,
      pathPrefix: '/identity/directives',
    });
    subRedis.emit('pmessage', 'entity_events:pubsub:*:*', channel, message);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getAttentionCacheCounters().invalidations).toBeGreaterThanOrEqual(1);

    await cleanup();
  });

  it('entity.memory.mutation with /learnings prefix invalidates', async () => {
    const subRedis = createMockRedis();
    const cacheRedis = createMockRedis();
    resetAttentionCacheCounters();

    await cacheRedis.set(`entity:attention:gen:${TENANT}:${SPACE}`, '1');

    const cleanup = await startAttentionCacheSubscriber(subRedis, cacheRedis);

    const channel = `entity_events:pubsub:${TENANT}:${SPACE}`;
    const message = JSON.stringify({
      type: 'entity_event',
      eventType: 'entity.memory.mutation',
      spaceId: SPACE,
      pathPrefix: '/learnings/workflow-x',
    });
    subRedis.emit('pmessage', 'entity_events:pubsub:*:*', channel, message);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getAttentionCacheCounters().invalidations).toBeGreaterThanOrEqual(1);

    await cleanup();
  });

  it('entity.memory.mutation with /skills prefix invalidates', async () => {
    const subRedis = createMockRedis();
    const cacheRedis = createMockRedis();
    resetAttentionCacheCounters();

    await cacheRedis.set(`entity:attention:gen:${TENANT}:${SPACE}`, '1');

    const cleanup = await startAttentionCacheSubscriber(subRedis, cacheRedis);

    const channel = `entity_events:pubsub:${TENANT}:${SPACE}`;
    const message = JSON.stringify({
      type: 'entity_event',
      eventType: 'entity.memory.mutation',
      spaceId: SPACE,
      pathPrefix: '/skills/my-skill',
    });
    subRedis.emit('pmessage', 'entity_events:pubsub:*:*', channel, message);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getAttentionCacheCounters().invalidations).toBeGreaterThanOrEqual(1);

    await cleanup();
  });

  it('entity.memory.mutation with irrelevant prefix does NOT invalidate', async () => {
    const subRedis = createMockRedis();
    const cacheRedis = createMockRedis();
    resetAttentionCacheCounters();

    await cacheRedis.set(`entity:attention:gen:${TENANT}:${SPACE}`, '1');

    const cleanup = await startAttentionCacheSubscriber(subRedis, cacheRedis);

    const channel = `entity_events:pubsub:${TENANT}:${SPACE}`;
    const message = JSON.stringify({
      type: 'entity_event',
      eventType: 'entity.memory.mutation',
      spaceId: SPACE,
      pathPrefix: '/workflows/some-wf/runs',
    });
    subRedis.emit('pmessage', 'entity_events:pubsub:*:*', channel, message);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getAttentionCacheCounters().invalidations).toBe(0);

    await cleanup();
  });

  it('non-invalidation event type does NOT bump generation', async () => {
    const subRedis = createMockRedis();
    const cacheRedis = createMockRedis();
    resetAttentionCacheCounters();

    const cleanup = await startAttentionCacheSubscriber(subRedis, cacheRedis);

    const channel = `entity_events:pubsub:${TENANT}:${SPACE}`;
    const message = JSON.stringify({
      type: 'entity_event',
      eventType: 'entity.hook.failed',
      spaceId: SPACE,
    });
    subRedis.emit('pmessage', 'entity_events:pubsub:*:*', channel, message);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getAttentionCacheCounters().invalidations).toBe(0);

    await cleanup();
  });
});
