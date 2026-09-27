import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';

import { markStepCancelled, publishStepAbort, wasStepCancelled } from '../streams/control.js';

describe('publishStepAbort', () => {
  it('addresses the step execution directly', () => {
    const publish = vi.fn().mockResolvedValue(1);
    publishStepAbort({ publish } as unknown as Redis, 'step-exec-1', 'cancelled');
    expect(publish).toHaveBeenCalledWith('aflow:abort:step-exec-1', 'cancelled');
  });

  it('survives a client that throws synchronously', () => {
    // Callers run this alongside the durable cancellation path. A publish that
    // threw here once aborted the whole cascade, so the run was never cancelled
    // at all — strictly worse than not reaching the executor.
    const publish = vi.fn(() => {
      throw new Error('connection closed');
    });
    expect(() =>
      publishStepAbort({ publish } as unknown as Redis, 'step-exec-2', 'cancelled'),
    ).not.toThrow();
  });

  it('survives a rejected publish without an unhandled rejection', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('no connection'));
    publishStepAbort({ publish } as unknown as Redis, 'step-exec-3', 'interrupted');
    await new Promise((resolve) => setImmediate(resolve));
    expect(publish).toHaveBeenCalledOnce();
  });
});

describe('markStepCancelled / wasStepCancelled', () => {
  function fakeRedis(store: Map<string, string>) {
    return {
      set: vi.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve('OK');
      }),
      exists: vi.fn((key: string) => Promise.resolve(store.has(key) ? 1 : 0)),
    } as unknown as Redis;
  }

  it('records a cancellation the executor can read back', async () => {
    const store = new Map<string, string>();
    const redis = fakeRedis(store);

    await markStepCancelled(redis, 'step-1', 1, 'cancelled');

    expect(await wasStepCancelled(redis, 'step-1', 1)).toBe(true);
    expect(store.get('aflow:cancelled:step-1:1')).toBe('cancelled');
  });

  it('does not block the NEXT attempt of the same step', async () => {
    // A retry reuses the step execution id and only bumps the attempt
    // (`updateStepStateForRetry`). Keyed on the id alone, a cancellation record
    // would outlive what it describes and silently drop the retry.
    const store = new Map<string, string>();
    const redis = fakeRedis(store);

    await markStepCancelled(redis, 'step-1', 1, 'cancelled');

    expect(await wasStepCancelled(redis, 'step-1', 2)).toBe(false);
  });

  it('expires, so cancelled ids cannot accumulate forever', async () => {
    const store = new Map<string, string>();
    const redis = fakeRedis(store);

    await markStepCancelled(redis, 'step-1', 1, 'cancelled');

    const args = (redis.set as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(args?.[2]).toBe('EX');
    expect(typeof args?.[3]).toBe('number');
  });

  it('fails OPEN when redis is unreachable', async () => {
    // A blip must never stop a job that was not cancelled.
    const redis = {
      set: vi.fn().mockRejectedValue(new Error('no connection')),
      exists: vi.fn().mockRejectedValue(new Error('no connection')),
    } as unknown as Redis;

    await expect(markStepCancelled(redis, 'step-1', 1, 'cancelled')).resolves.toBeUndefined();
    expect(await wasStepCancelled(redis, 'step-1', 1)).toBe(false);
  });
});
