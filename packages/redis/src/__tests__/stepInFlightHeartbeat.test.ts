import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  registerStepInFlight,
  extendStepInFlight,
  getStepInFlight,
  clearStepInFlight,
} from '../streams/executorHeartbeat.js';

describe('per-step in-flight heartbeat', () => {
  let redis: RedisType;
  const stepId = 'step-exec-1';

  beforeEach(() => {
    redis = new Redis() as unknown as RedisType;
  });

  it('reports not-alive when no key exists', async () => {
    const status = await getStepInFlight(redis, stepId);
    expect(status).toEqual({ alive: false, deadlineAtMs: null });
  });

  it('reports alive and preserves the deadline once registered', async () => {
    await registerStepInFlight(redis, stepId, 1_700_000_000_000);
    const status = await getStepInFlight(redis, stepId);
    expect(status.alive).toBe(true);
    expect(status.deadlineAtMs).toBe(1_700_000_000_000);
  });

  it('reports alive with a null deadline before the timeout is known', async () => {
    await registerStepInFlight(redis, stepId, null);
    const status = await getStepInFlight(redis, stepId);
    expect(status).toEqual({ alive: true, deadlineAtMs: null });
  });

  it('a later registration refreshes the deadline', async () => {
    await registerStepInFlight(redis, stepId, null);
    await registerStepInFlight(redis, stepId, 42);
    expect((await getStepInFlight(redis, stepId)).deadlineAtMs).toBe(42);
  });

  it('clears liveness so a reaped step cannot be resurrected', async () => {
    await registerStepInFlight(redis, stepId, 1);
    await clearStepInFlight(redis, stepId);
    expect(await getStepInFlight(redis, stepId)).toEqual({ alive: false, deadlineAtMs: null });
  });

  it('an extension keeps the recorded deadline and renews the lifetime', async () => {
    await registerStepInFlight(redis, stepId, 42);
    await redis.expire('aflow:step-inflight:' + stepId, 5);
    await extendStepInFlight(redis, stepId);
    expect((await getStepInFlight(redis, stepId)).deadlineAtMs).toBe(42);
    expect(await redis.ttl('aflow:step-inflight:' + stepId)).toBeGreaterThan(5);
  });

  it('an extension never resurrects a cleared record', async () => {
    await registerStepInFlight(redis, stepId, 1);
    await clearStepInFlight(redis, stepId);
    await extendStepInFlight(redis, stepId);
    expect(await getStepInFlight(redis, stepId)).toEqual({ alive: false, deadlineAtMs: null });
  });

  it('sets a TTL so a vanished executor eventually drops liveness', async () => {
    await registerStepInFlight(redis, stepId, 1);
    const ttl = await redis.ttl('aflow:step-inflight:' + stepId);
    expect(ttl).toBeGreaterThan(0);
  });
});
