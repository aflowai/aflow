import { afterEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';

const FIRST_BEAT_MS = Date.UTC(2026, 9, 4, 2, 0, 0);
const LATER_BEAT_MS = FIRST_BEAT_MS + 10_000;

/** A reader in a process that started after the executor last beat. */
async function restartedReader(): Promise<typeof import('../streams/executorHeartbeat.js')> {
  vi.resetModules();
  return await import('../streams/executorHeartbeat.js');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('whether an executor of a type was ever seen', () => {
  it('is recorded in Redis by its first heartbeat, so a restarted reader still knows once the heartbeat lapses', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const executorSide = new Redis() as unknown as RedisType;
    const { registerExecutorHeartbeat, unregisterExecutorHeartbeat } =
      await import('../streams/executorHeartbeat.js');

    vi.setSystemTime(FIRST_BEAT_MS);
    await registerExecutorHeartbeat(executorSide, 'browser', 'seen-probe');
    vi.setSystemTime(LATER_BEAT_MS);
    await registerExecutorHeartbeat(executorSide, 'browser', 'seen-probe');
    await unregisterExecutorHeartbeat(executorSide, 'browser', 'seen-probe');

    const reader = await restartedReader();
    const orchestratorSide = new Redis() as unknown as RedisType;
    expect(await reader.hasAvailableExecutor(orchestratorSide, 'browser')).toBe(false);
    expect(await reader.hasExecutorEverBeenSeen(orchestratorSide, 'browser')).toBe(true);
    expect(await orchestratorSide.get('aflow:executor-seen:browser')).toBe(String(FIRST_BEAT_MS));
    expect(await orchestratorSide.ttl('aflow:executor-seen:browser')).toBe(-1);
  });

  it('is not for a type whose executor never beat', async () => {
    const reader = await restartedReader();
    const redis = new Redis() as unknown as RedisType;

    expect(await reader.hasExecutorEverBeenSeen(redis, 'compute')).toBe(false);
  });
});
