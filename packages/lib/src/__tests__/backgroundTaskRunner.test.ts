import { describe, expect, it, vi } from 'vitest';
import {
  createBackgroundTaskRunner,
  type BackgroundTaskCycleEvent,
  type BackgroundTaskLease,
} from '../backgroundTask/runner.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BASE = {
  taskId: 'test.task',
  scope: 'per_instance' as const,
  intervalMs: 5,
  maxBatch: 10,
  maxCycleMs: 1000,
  jitterRatio: 0,
  runImmediately: true,
  unref: false,
};

describe('createBackgroundTaskRunner', () => {
  it('never overlaps cycles', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let completed = 0;

    const runner = createBackgroundTaskRunner(BASE, async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(20);
      concurrent -= 1;
      completed += 1;
      return {};
    });

    runner.start();
    await sleep(120);
    await runner.stop();

    expect(maxConcurrent).toBe(1);
    expect(completed).toBeGreaterThan(1);
  });

  it('backs off exponentially on consecutive failures', async () => {
    const delays: number[] = [];
    const runner = createBackgroundTaskRunner(
      {
        ...BASE,
        errorBackoffMs: 10,
        maxErrorBackoffMs: 200,
        observer: {
          onCycle(event: BackgroundTaskCycleEvent) {
            delays.push(event.nextDelayMs);
          },
        },
      },
      () => {
        throw new Error('boom');
      },
    );

    runner.start();
    await sleep(100);
    await runner.stop();

    expect(delays.length).toBeGreaterThanOrEqual(3);
    expect(delays[0]).toBe(10);
    expect(delays[1]).toBe(20);
    expect(delays[2]).toBe(40);
    expect(runner.status().consecutiveErrors).toBeGreaterThanOrEqual(3);
  });

  it('re-arms immediately while a backlog remains', async () => {
    const delays: number[] = [];
    let cycles = 0;
    const runner = createBackgroundTaskRunner(
      {
        ...BASE,
        intervalMs: 10_000,
        observer: {
          onCycle(event) {
            delays.push(event.nextDelayMs);
          },
        },
      },
      () => {
        cycles += 1;
        return Promise.resolve({ candidates: 10, processed: 10, hasMore: cycles < 3 });
      },
    );

    runner.start();
    await sleep(60);
    await runner.stop();

    expect(cycles).toBe(3);
    expect(delays.slice(0, 2)).toEqual([0, 0]);
    expect(delays[2]).toBe(10_000);
  });

  it('aborts the in-flight cycle on stop', async () => {
    let aborted = false;
    const runner = createBackgroundTaskRunner(BASE, async (ctx) => {
      ctx.signal.addEventListener('abort', () => {
        aborted = true;
      });
      await sleep(50);
      return {};
    });

    runner.start();
    await sleep(10);
    await runner.stop();

    expect(aborted).toBe(true);
    expect(runner.status().running).toBe(false);
  });

  it('skips the cycle when a singleton lease is held elsewhere', async () => {
    let ran = 0;
    const lease: BackgroundTaskLease = {
      acquire: () => Promise.resolve(null),
      release: () => Promise.resolve(),
    };
    const runner = createBackgroundTaskRunner({ ...BASE, lease }, () => {
      ran += 1;
      return Promise.resolve({});
    });

    runner.start();
    await sleep(40);
    await runner.stop();

    expect(ran).toBe(0);
  });

  it('releases the lease it acquired, including after a failure', async () => {
    const released: string[] = [];
    const lease: BackgroundTaskLease = {
      acquire: () => Promise.resolve('token-1'),
      release: (token) => {
        released.push(token);
        return Promise.resolve();
      },
    };
    const runner = createBackgroundTaskRunner({ ...BASE, intervalMs: 10_000, lease }, () => {
      throw new Error('boom');
    });

    runner.start();
    await sleep(20);
    await runner.stop();

    expect(released).toContain('token-1');
  });

  it('does not start when the resolved mode is disabled', async () => {
    let ran = 0;
    const warn = vi.fn();
    const runner = createBackgroundTaskRunner(
      {
        ...BASE,
        mode: 'disabled',
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      },
      () => {
        ran += 1;
        return Promise.resolve({});
      },
    );

    runner.start();
    await sleep(30);
    await runner.stop();

    expect(ran).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('tells the cycle when side effects must be suppressed', async () => {
    const modes: string[] = [];
    const runner = createBackgroundTaskRunner({ ...BASE, mode: 'observe' }, (ctx) => {
      modes.push(ctx.mode);
      return Promise.resolve({});
    });

    runner.start();
    await sleep(20);
    await runner.stop();

    expect(modes.length).toBeGreaterThan(0);
    expect(new Set(modes)).toEqual(new Set(['observe']));
  });

  it('reports a cycle that overran its time budget', async () => {
    const outcomes: string[] = [];
    const warn = vi.fn();
    const runner = createBackgroundTaskRunner(
      {
        ...BASE,
        intervalMs: 10_000,
        maxCycleMs: 5,
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
        observer: {
          onCycle(event) {
            outcomes.push(event.outcome);
          },
        },
      },
      async (ctx) => {
        await sleep(30);
        expect(ctx.budgetExhausted()).toBe(true);
        return {};
      },
    );

    runner.start();
    await sleep(60);
    await runner.stop();

    expect(outcomes).toContain('budget_exceeded');
    expect(warn).toHaveBeenCalled();
  });

  it('treats a rejecting lease acquire as a failed cycle', async () => {
    // Acquiring outside the try/catch let the rejection escape the runner: no
    // backoff, no observer event, and an unhandled rejection from `void tick()`.
    const outcomes: string[] = [];
    const lease: BackgroundTaskLease = {
      acquire: () => Promise.reject(new Error('ECONNRESET')),
      release: () => Promise.resolve(),
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const runner = createBackgroundTaskRunner(
      {
        ...BASE,
        lease,
        errorBackoffMs: 10,
        observer: {
          onCycle(event) {
            outcomes.push(event.outcome);
          },
        },
      },
      () => Promise.resolve({}),
    );

    runner.start();
    await sleep(60);
    await runner.stop();
    process.off('unhandledRejection', onUnhandled);

    expect(outcomes).toContain('failed');
    expect(runner.status().consecutiveErrors).toBeGreaterThan(0);
    expect(unhandled).toEqual([]);
  });

  it('makes runOnce take the same slot as a scheduled cycle', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const runner = createBackgroundTaskRunner({ ...BASE, intervalMs: 5 }, async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(25);
      concurrent -= 1;
      return {};
    });

    runner.start();
    await sleep(5);
    await runner.runOnce();
    await runner.stop();

    expect(maxConcurrent).toBe(1);
  });

  it('refuses runOnce when an operator disabled the task', async () => {
    let ran = 0;
    const runner = createBackgroundTaskRunner({ ...BASE, mode: 'disabled' }, () => {
      ran += 1;
      return Promise.resolve({});
    });

    await expect(runner.runOnce()).rejects.toThrow(/disabled by override/);
    expect(ran).toBe(0);
  });

  it('refuses a non-positive cadence instead of spinning', () => {
    expect(() =>
      createBackgroundTaskRunner({ ...BASE, intervalMs: 0 }, () => Promise.resolve({})),
    ).toThrow(/positive intervalMs/);
  });

  it('survives a start that lands while a stop is awaiting its cycle', async () => {
    // stop() used to null the controller unconditionally after its await, which
    // destroyed the one a concurrent start() had just installed: every later
    // tick bailed on a missing signal while status() still reported running.
    let cycles = 0;
    const runner = createBackgroundTaskRunner({ ...BASE, intervalMs: 10 }, async () => {
      cycles += 1;
      await sleep(30);
      return {};
    });

    runner.start();
    await sleep(5);
    const stopping = runner.stop();
    runner.start();
    await stopping;

    const afterRestart = cycles;
    await sleep(80);
    expect(cycles).toBeGreaterThan(afterRestart);
    await runner.stop();
  });

  it('refuses a singleton task with no lease', () => {
    expect(() =>
      createBackgroundTaskRunner({ ...BASE, scope: 'singleton' }, () => Promise.resolve({})),
    ).toThrow(/declared singleton but was given no lease/);
  });

  it('aborts the cycle signal when the time budget runs out', async () => {
    // Without this the budget is a report after the fact: a hung datastore call
    // outlives the lease that made the work safe.
    let abortedWithinBudget = false;
    const runner = createBackgroundTaskRunner(
      { ...BASE, intervalMs: 10_000, maxCycleMs: 20 },
      async (ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve();
            return;
          }
          ctx.signal.addEventListener('abort', () => {
            abortedWithinBudget = true;
            resolve();
          });
        });
        return {};
      },
    );

    runner.start();
    await sleep(80);
    await runner.stop();

    expect(abortedWithinBudget).toBe(true);
  });

  it('gives up on a cycle that ignores the abort instead of hanging shutdown', async () => {
    const warn = vi.fn();
    const runner = createBackgroundTaskRunner(
      {
        ...BASE,
        intervalMs: 10_000,
        maxCycleMs: 10_000,
        shutdownTimeoutMs: 30,
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      },
      async () => {
        await sleep(5_000);
        return {};
      },
    );

    runner.start();
    await sleep(10);
    const startedAt = Date.now();
    await runner.stop();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(warn).toHaveBeenCalled();
  });

  it('spreads instances apart with startup jitter', () => {
    const armed: number[] = [];
    const original = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      armed.push(ms ?? 0);
      return original(() => undefined, 100_000) as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      for (let i = 0; i < 20; i++) {
        createBackgroundTaskRunner(
          { ...BASE, intervalMs: 1000, jitterRatio: 0.5, runImmediately: false },
          () => Promise.resolve({}),
        ).start();
      }
    } finally {
      spy.mockRestore();
    }

    expect(new Set(armed).size).toBeGreaterThan(1);
    for (const delay of armed) {
      expect(delay).toBeGreaterThanOrEqual(750);
      expect(delay).toBeLessThanOrEqual(1250);
    }
  });
});
