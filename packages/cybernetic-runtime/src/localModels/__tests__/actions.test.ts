import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import type { LocalPullProgress, LocalRuntimeClient } from '@aflow/ai-client';
import { readLocalPulls } from '@aflow/redis';
import { applyLocalModelAction, cancelLocalModelPull } from '../actions.js';
import type { SpaceLocalRuntime } from '../runtime.js';

const GIB = 1024 ** 3;
const RUNTIME_ID = 'this-machine:11434';
let redis: RedisType;

beforeEach(async () => {
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

afterEach(() => {
  redis.disconnect();
});

/** A runtime whose pull waits until the test lets it go, reporting progress each time it is told to. */
function runtime(freeDiskBytes: number | undefined) {
  let report: ((p: LocalPullProgress) => void) | undefined;
  let finish: (() => void) | undefined;
  let fail: ((e: Error) => void) | undefined;
  const pulls: string[] = [];
  const client: Partial<LocalRuntimeClient> = {
    installed: async () => [],
    pull: (tag, onProgress, signal) =>
      new Promise<void>((resolve, reject) => {
        pulls.push(tag);
        report = onProgress;
        finish = resolve;
        fail = reject;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  };
  const local: SpaceLocalRuntime = {
    config: {},
    client: client as LocalRuntimeClient,
    runtimeId: RUNTIME_ID,
    credential: { id: 'c', scope: 'user', scopeId: 'u' },
    hostMachine:
      freeDiskBytes === undefined
        ? undefined
        : { totalMemoryBytes: 24 * GIB, unifiedMemory: true, freeDiskBytes },
    hostname: undefined,
  };
  return {
    local,
    pulls,
    report: (p: LocalPullProgress) => report?.(p),
    finish: () => finish?.(),
    fail: (e: Error) => fail?.(e),
  };
}

const ctx = (local: SpaceLocalRuntime) => ({
  db: {} as never,
  redis,
  tenantId: 't',
  runtime: local,
});
const pull = { action: 'pull' as const, model: 'ollama-gemma4-26b' };

describe('a download to this computer', () => {
  it('is refused before it starts when the disk cannot hold it', async () => {
    const r = runtime(10 * GIB);
    const outcome = await applyLocalModelAction(ctx(r.local), pull);
    expect(outcome).toMatchObject({ ok: false, reason: 'no_disk' });
    expect(r.pulls).toEqual([]);
  });

  it('joins a pull already downloading instead of starting another', async () => {
    const r = runtime(100 * GIB);
    expect(await applyLocalModelAction(ctx(r.local), pull)).toMatchObject({ ok: true });
    const second = await applyLocalModelAction(ctx(r.local), pull);
    expect(second).toEqual({ ok: true, message: 'gemma4:26b is already downloading.' });
    expect(r.pulls).toEqual(['gemma4:26b']);
  });

  it('stops when the operator cancels, and says it stopped rather than failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const r = runtime(100 * GIB);
    await applyLocalModelAction(ctx(r.local), pull);
    expect(await cancelLocalModelPull(redis, r.local, 'ollama-gemma4-26b')).toBe(true);

    vi.setSystemTime(Date.now() + 5_000);
    r.report({ status: 'pulling 48eb', completedBytes: 1, totalBytes: 2 });
    await vi.waitFor(async () => {
      expect(
        (await readLocalPulls(redis, RUNTIME_ID, ['gemma4:26b'])).get('gemma4:26b')?.status,
      ).toBe('interrupted');
    });
    vi.useRealTimers();
  });

  it('records why a pull failed', async () => {
    const r = runtime(100 * GIB);
    await applyLocalModelAction(ctx(r.local), pull);
    r.fail(new Error('max retries exceeded'));
    await vi.waitFor(async () => {
      expect(
        (await readLocalPulls(redis, RUNTIME_ID, ['gemma4:26b'])).get('gemma4:26b'),
      ).toMatchObject({
        status: 'failed',
        error: 'max retries exceeded',
      });
    });
  });

  it('leaves the model for the runtime to list once it is installed', async () => {
    const r = runtime(100 * GIB);
    await applyLocalModelAction(ctx(r.local), pull);
    r.finish();
    await vi.waitFor(async () => {
      expect((await readLocalPulls(redis, RUNTIME_ID, ['gemma4:26b'])).size).toBe(0);
    });
  });
});

describe('a role assignment', () => {
  it('is left to the space settings, which set every role at once', async () => {
    const r = runtime(undefined);
    const outcome = await applyLocalModelAction(ctx(r.local), {
      action: 'use_for_every_role',
      model: 'ollama-gemma4-26b',
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'not_here' });
  });
});
