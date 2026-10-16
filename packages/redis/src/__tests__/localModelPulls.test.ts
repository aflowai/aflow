import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  claimLocalPull,
  endLocalPull,
  readLocalPulls,
  recordLocalPullProgress,
  requestLocalPullCancel,
} from '../localModelPulls.js';

const RUNTIME = 'this-machine:11434';
const TAG = 'gemma4:26b';
let redis: RedisType;

beforeEach(async () => {
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

afterEach(() => {
  redis.disconnect();
});

describe('a pull on a local runtime', () => {
  it('is claimed once: a second request while it downloads joins it', async () => {
    expect(await claimLocalPull(redis, RUNTIME, TAG)).toBe(true);
    expect(await claimLocalPull(redis, RUNTIME, TAG)).toBe(false);
  });

  it('reports its progress to whoever reads it', async () => {
    await claimLocalPull(redis, RUNTIME, TAG, new Date('2026-10-16T20:00:00Z'));
    await recordLocalPullProgress(redis, RUNTIME, TAG, {
      completedBytes: 4_000,
      totalBytes: 16_000,
      detail: 'pulling 48eb98ec',
    });

    expect((await readLocalPulls(redis, RUNTIME, [TAG, 'other:1b'])).get(TAG)).toEqual({
      status: 'downloading',
      completedBytes: 4_000,
      totalBytes: 16_000,
      detail: 'pulling 48eb98ec',
      error: null,
      startedAt: '2026-10-16T20:00:00.000Z',
    });
  });

  it('hears a cancel on its next progress, wherever it was asked', async () => {
    await claimLocalPull(redis, RUNTIME, TAG);
    expect(await requestLocalPullCancel(redis, RUNTIME, TAG)).toBe(true);
    const { cancelled } = await recordLocalPullProgress(redis, RUNTIME, TAG, {
      completedBytes: 1,
      totalBytes: null,
      detail: '',
    });
    expect(cancelled).toBe(true);
  });

  it('leaves no record once installed, and a readable one once stopped, which a new pull replaces', async () => {
    await claimLocalPull(redis, RUNTIME, TAG);
    await endLocalPull(redis, RUNTIME, TAG, { status: 'interrupted', error: null });
    expect((await readLocalPulls(redis, RUNTIME, [TAG])).get(TAG)?.status).toBe('interrupted');

    expect(await claimLocalPull(redis, RUNTIME, TAG)).toBe(true);
    await endLocalPull(redis, RUNTIME, TAG, { status: 'installed' });
    expect((await readLocalPulls(redis, RUNTIME, [TAG])).size).toBe(0);
  });

  it('cannot be cancelled once it is not downloading', async () => {
    expect(await requestLocalPullCancel(redis, RUNTIME, TAG)).toBe(false);
  });
});
