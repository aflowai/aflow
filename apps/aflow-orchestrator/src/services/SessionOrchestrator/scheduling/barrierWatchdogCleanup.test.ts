import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { removeBarrierWatchdogOnClear } from './barrierWatchdogCleanup.js';

const redis = {} as unknown as Redis;

describe('removeBarrierWatchdogOnClear (failure-side symmetric cleanup)', () => {
  it('removes the watchdog when the decrement reaches zero', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const issued = await removeBarrierWatchdogOnClear(redis, remove, {
      tenantId: 't',
      runId: 'r',
      agentStepId: 'agent',
      newCount: 0,
    });

    expect(issued).toBe(true);
    expect(remove).toHaveBeenCalledWith(redis, 't', 'r', 'agent');
  });

  it('does NOT remove the watchdog while calls remain pending', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const issued = await removeBarrierWatchdogOnClear(redis, remove, {
      tenantId: 't',
      runId: 'r',
      agentStepId: 'agent',
      newCount: 2,
    });

    expect(issued).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it('swallows a removal failure (best-effort, like the success path)', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('redis down'));
    await expect(
      removeBarrierWatchdogOnClear(redis, remove, {
        tenantId: 't',
        runId: 'r',
        agentStepId: 'agent',
        newCount: 0,
      }),
    ).resolves.toBe(true);
  });
});
