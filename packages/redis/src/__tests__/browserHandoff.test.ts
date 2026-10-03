import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';

import {
  BROWSER_HANDOFF_EXPIRY_MARGIN_MS,
  browserHandoffKey,
  browserHandoffSpaceIndexKey,
  joinBrowserHandoff,
  type JoinBrowserHandoffInput,
  leaveBrowserHandoff,
  readSpaceBrowserHandoffs,
} from '../browserHandoff.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-0000000000a1';
const OTHER_SPACE = '00000000-0000-0000-0000-0000000000b2';
const MINUTE = 60_000;

let redis: RedisType;

beforeEach(async () => {
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

function waitOn(
  stepExecutionId: string,
  overrides: Partial<JoinBrowserHandoffInput['waiter']> = {},
  startedAt = Date.now(),
): JoinBrowserHandoffInput {
  return {
    hostname: 'laptop',
    profileId: 'default',
    site: 'example.com',
    reason: 'sign_in',
    message: `Sign in for ${stepExecutionId}.`,
    startedAt,
    waiter: {
      tenantId: TENANT,
      spaceId: SPACE,
      runId: `run-${stepExecutionId}`,
      stepExecutionId,
      deadlineAt: startedAt + 15 * MINUTE,
      ...overrides,
    },
  };
}

const KEY = browserHandoffKey('laptop', 'default', 'example.com');

describe('an open hand-off', () => {
  it('is one record for two runs waiting on one site, the first run’s words standing', async () => {
    await joinBrowserHandoff(redis, waitOn('step-1'));
    await joinBrowserHandoff(redis, waitOn('step-2'));

    const open = await readSpaceBrowserHandoffs(redis, TENANT, SPACE);
    expect(open).toHaveLength(1);
    expect(open[0]?.key).toBe(KEY);
    expect(open[0]?.message).toBe('Sign in for step-1.');
    expect(open[0]?.waiting.map((w) => w.stepExecutionId).sort()).toEqual(['step-1', 'step-2']);
  });

  it('shows each space only its own runs', async () => {
    await joinBrowserHandoff(redis, waitOn('step-1'));
    await joinBrowserHandoff(redis, waitOn('step-9', { spaceId: OTHER_SPACE }));

    const mine = await readSpaceBrowserHandoffs(redis, TENANT, SPACE);
    const theirs = await readSpaceBrowserHandoffs(redis, TENANT, OTHER_SPACE);
    expect(mine[0]?.waiting.map((w) => w.stepExecutionId)).toEqual(['step-1']);
    expect(theirs[0]?.waiting.map((w) => w.stepExecutionId)).toEqual(['step-9']);
  });

  it('is gone when its last run leaves, and kept while one remains', async () => {
    await joinBrowserHandoff(redis, waitOn('step-1'));
    await joinBrowserHandoff(redis, waitOn('step-2'));

    const stepOne = { key: KEY, tenantId: TENANT, spaceId: SPACE, stepExecutionId: 'step-1' };
    expect(await leaveBrowserHandoff(redis, stepOne)).toBe(true);
    expect((await readSpaceBrowserHandoffs(redis, TENANT, SPACE))[0]?.waiting).toHaveLength(1);

    expect(await leaveBrowserHandoff(redis, { ...stepOne, stepExecutionId: 'step-2' })).toBe(false);
    expect(await readSpaceBrowserHandoffs(redis, TENANT, SPACE)).toEqual([]);
    expect(await redis.exists(KEY)).toBe(0);
    expect(await redis.zcard(browserHandoffSpaceIndexKey(TENANT, SPACE))).toBe(0);
  });

  it('leaves another space’s index alone when a run of this one leaves', async () => {
    await joinBrowserHandoff(redis, waitOn('step-1'));
    await joinBrowserHandoff(redis, waitOn('step-9', { spaceId: OTHER_SPACE }));
    await leaveBrowserHandoff(redis, {
      key: KEY,
      tenantId: TENANT,
      spaceId: SPACE,
      stepExecutionId: 'step-1',
    });
    expect(await readSpaceBrowserHandoffs(redis, TENANT, SPACE)).toEqual([]);
    expect(await readSpaceBrowserHandoffs(redis, TENANT, OTHER_SPACE)).toHaveLength(1);
  });
});

describe('a hand-off nobody ends', () => {
  it('expires at its own deadline plus the margin', async () => {
    const startedAt = Date.now();
    await joinBrowserHandoff(redis, waitOn('step-1', {}, startedAt));

    const expiresIn = 15 * MINUTE + BROWSER_HANDOFF_EXPIRY_MARGIN_MS;
    const ttl = await redis.pttl(KEY);
    expect(ttl).toBeGreaterThan(expiresIn - 5_000);
    expect(ttl).toBeLessThanOrEqual(expiresIn);
    expect(await redis.pttl(browserHandoffSpaceIndexKey(TENANT, SPACE))).toBeGreaterThan(0);
  });

  it('is kept as long as the latest run waiting on it may wait', async () => {
    const startedAt = Date.now();
    await joinBrowserHandoff(redis, waitOn('step-1', {}, startedAt));
    await joinBrowserHandoff(redis, waitOn('step-2', { deadlineAt: startedAt + 40 * MINUTE }));

    expect(await redis.pttl(KEY)).toBeGreaterThan(
      40 * MINUTE + BROWSER_HANDOFF_EXPIRY_MARGIN_MS - 5_000,
    );
  });

  it('is no longer read once that time has passed', async () => {
    const startedAt = Date.now();
    await joinBrowserHandoff(redis, waitOn('step-1', {}, startedAt));
    const after = startedAt + 15 * MINUTE + BROWSER_HANDOFF_EXPIRY_MARGIN_MS + 1;
    expect(await readSpaceBrowserHandoffs(redis, TENANT, SPACE, after)).toEqual([]);
  });
});
