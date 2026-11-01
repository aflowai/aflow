/**
 * Contract: a machine runs one folder check at a time unless its policy says
 * `maxConcurrentChecks`, in a lane of its own beside the coding agents; and a
 * check asked to wait for a quiet machine waits until the one-minute load
 * average is below the core count or the wait's limit has passed, and records
 * how long it waited.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConcurrencyLimiter } from '@aflow/executor-runtime';
import { HOST_CHECK_QUIET_WAIT_MAX_MS, HOST_HARNESS_CONCURRENCY_DEFAULT } from '@aflow/schemas';

import { HOST_CHECK_CONCURRENCY_DEFAULT, HostPolicySchema, loadHostPolicy } from '../bindings.js';
import { COMMIT_CHECK_OPERATION } from '../handlers/checkHandlers.js';
import { HARNESS_RUN_OPERATION } from '../handlers/harnessHandlers.js';
import { limitHostLanes } from '../laneLimits.js';
import { describeQuietWait, QUIET_POLL_MS, waitForQuietMachine } from '../quietMachine.js';

/** The runtime's per-operation limits, as `ExecutorRuntime.limitOperation` keeps them. */
function limitsRuntime(): {
  limitOperation: (operationId: string, maxConcurrent: number) => void;
  limiters: Map<string, ConcurrencyLimiter>;
} {
  const limiters = new Map<string, ConcurrencyLimiter>();
  return {
    limiters,
    limitOperation(operationId, maxConcurrent) {
      const existing = limiters.get(operationId);
      if (existing === undefined) limiters.set(operationId, new ConcurrencyLimiter(maxConcurrent));
      else existing.setLimit(maxConcurrent);
    },
  };
}

async function policyWith(extra: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'check-lane-'));
  const path = join(dir, 'host-policy.json');
  await writeFile(path, JSON.stringify({ version: 1, bindings: [], ...extra }));
  return path;
}

/**
 * Start `count` steps of `operationId` through its limiter, each held until
 * the test ends it, and report how many ran at once at most.
 */
function admit(limiter: ConcurrencyLimiter, count: number) {
  let running = 0;
  let peak = 0;
  const ends: Array<() => void> = [];
  const done = Promise.all(
    Array.from({ length: count }, async () => {
      await limiter.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => ends.push(resolve));
        running -= 1;
      });
    }),
  );
  return {
    running: () => running,
    peak: () => peak,
    endOne: async () => {
      ends.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
    done,
  };
}

describe('the check lane', () => {
  it('runs one check at a time on a machine whose policy names no number', async () => {
    const policy = await loadHostPolicy(await policyWith({}));
    expect(policy.maxConcurrentChecks).toBe(HOST_CHECK_CONCURRENCY_DEFAULT);
    expect(HOST_CHECK_CONCURRENCY_DEFAULT).toBe(1);

    const runtime = limitsRuntime();
    limitHostLanes(runtime, policy);
    const checks = runtime.limiters.get(COMMIT_CHECK_OPERATION);
    const harnesses = runtime.limiters.get(HARNESS_RUN_OPERATION);
    if (checks === undefined || harnesses === undefined) throw new Error('a lane has no limit');

    const four = admit(checks, 4);
    const agents = admit(harnesses, HOST_HARNESS_CONCURRENCY_DEFAULT);
    await new Promise((resolve) => setImmediate(resolve));
    // The coding agents run beside the one check, outside its count.
    expect(four.running()).toBe(1);
    expect(agents.running()).toBe(HOST_HARNESS_CONCURRENCY_DEFAULT);
    expect(checks.waiting).toBe(3);

    for (let ended = 0; ended < 4; ended += 1) {
      expect(four.running()).toBe(1);
      await four.endOne();
    }
    await four.done;
    expect(four.peak()).toBe(1);
    for (let ended = 0; ended < HOST_HARNESS_CONCURRENCY_DEFAULT; ended += 1) await agents.endOne();
    await agents.done;
  });

  it('runs the operator’s number of checks, and follows a change of it', async () => {
    const runtime = limitsRuntime();
    limitHostLanes(runtime, await loadHostPolicy(await policyWith({ maxConcurrentChecks: 2 })));
    expect(runtime.limiters.get(COMMIT_CHECK_OPERATION)?.limit).toBe(2);
    limitHostLanes(runtime, await loadHostPolicy(await policyWith({})));
    expect(runtime.limiters.get(COMMIT_CHECK_OPERATION)?.limit).toBe(1);
  });

  it('refuses a number of checks that is not a whole number of at least one', () => {
    for (const maxConcurrentChecks of [0, 1.5, 'two']) {
      expect(
        HostPolicySchema.safeParse({ version: 1, bindings: [], maxConcurrentChecks }).success,
        String(maxConcurrentChecks),
      ).toBe(false);
    }
  });
});

/** A machine whose load average reads from `loads` in turn, with a clock the waits move. */
function loadedMachine(loads: readonly number[], cores: number) {
  let clock = 0;
  let reads = 0;
  const slept: number[] = [];
  return {
    machine: {
      loadAverage: () => loads[Math.min(reads++, loads.length - 1)] ?? 0,
      cores: () => cores,
    },
    now: () => clock,
    sleep: (ms: number) => {
      slept.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    slept,
  };
}

describe('the wait for a quiet machine', () => {
  it('waits while the load average is at or above the core count, and records how long', async () => {
    const world = loadedMachine([39, 20, 10, 7.5], 10);
    const announced: number[] = [];
    const wait = await waitForQuietMachine({
      signal: new AbortController().signal,
      ...world,
      onWaiting: (load) => announced.push(load),
    });
    expect(wait).toEqual({ waitedMs: 3 * QUIET_POLL_MS, quiet: true, loadAverage: 7.5, cores: 10 });
    expect(announced).toEqual([39]);
    expect(describeQuietWait(wait)).toBe(
      'The checks waited 45 s for the machine to quieten, until its load average was 7.5 on 10 cores.',
    );
  });

  it('does not wait on a quiet machine, and says so', async () => {
    const wait = await waitForQuietMachine({
      signal: new AbortController().signal,
      ...loadedMachine([3], 10),
    });
    expect(wait).toEqual({ waitedMs: 0, quiet: true, loadAverage: 3, cores: 10 });
    expect(describeQuietWait(wait)).toContain('so they ran at once');
  });

  it('stops waiting after ten minutes, and records that the load never fell', async () => {
    const world = loadedMachine([39], 10);
    const wait = await waitForQuietMachine({ signal: new AbortController().signal, ...world });
    expect(HOST_CHECK_QUIET_WAIT_MAX_MS).toBe(10 * 60_000);
    expect(wait).toEqual({
      waitedMs: HOST_CHECK_QUIET_WAIT_MAX_MS,
      quiet: false,
      loadAverage: 39,
      cores: 10,
    });
    expect(world.slept.reduce((sum, ms) => sum + ms, 0)).toBe(HOST_CHECK_QUIET_WAIT_MAX_MS);
    expect(describeQuietWait(wait)).toBe(
      'The checks waited 10.0 min for the machine to quieten and then ran on a loaded machine, its load average 39.0 on 10 cores.',
    );
  });

  it('ends the wait at once when the step is stopped', async () => {
    const stop = new AbortController();
    const world = loadedMachine([39], 10);
    const wait = await waitForQuietMachine({
      signal: stop.signal,
      ...world,
      sleep: (ms) => {
        stop.abort();
        return world.sleep(ms);
      },
    });
    expect(wait.quiet).toBe(false);
    expect(world.slept).toHaveLength(1);
  });
});
