import { describe, it, expect } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  executorSeenSinceStart,
  hasAvailableExecutor,
  registerExecutorHeartbeat,
  unregisterExecutorHeartbeat,
} from '../streams/executorHeartbeat.js';

describe('an executor seen since this process started', () => {
  it('is one whose heartbeat a look has found, and stays seen once the heartbeat lapses', async () => {
    const redis = new Redis() as unknown as RedisType;

    expect(await hasAvailableExecutor(redis, 'browser')).toBe(false);
    expect(executorSeenSinceStart('browser')).toBe(false);

    await registerExecutorHeartbeat(redis, 'browser', 'seen-probe');
    expect(await hasAvailableExecutor(redis, 'browser')).toBe(true);
    await unregisterExecutorHeartbeat(redis, 'browser', 'seen-probe');

    expect(await hasAvailableExecutor(redis, 'browser')).toBe(false);
    expect(executorSeenSinceStart('browser')).toBe(true);
    expect(executorSeenSinceStart('host')).toBe(false);
  });
});
