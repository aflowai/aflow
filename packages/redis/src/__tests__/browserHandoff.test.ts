import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';

import {
  BROWSER_HANDOFF_CLEAR_BATCH,
  BROWSER_HANDOFF_EXPIRY_MARGIN_MS,
  browserHandoffKey,
  browserHandoffMachineIndexKey,
  browserHandoffSpaceIndexKey,
  clearMachineBrowserHandoffs,
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

afterEach(() => {
  redis.disconnect();
});

function waitOn(
  stepExecutionId: string,
  overrides: Partial<JoinBrowserHandoffInput['waiter']> = {},
  startedAt = Date.now(),
): JoinBrowserHandoffInput {
  return {
    installationId: 'install-a',
    machineLabel: 'laptop',
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

const KEY = browserHandoffKey('install-a', 'default', 'example.com');

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
    // What an agent wrote is its own space's; what the system knows is shared.
    expect(mine[0]?.message).toBe('Sign in for step-1.');
    expect(theirs[0]?.message).toBe('Sign in for step-9.');
    expect(theirs[0]?.key).toBe(mine[0]?.key);
    expect(theirs[0]?.startedAt).toBe(mine[0]?.startedAt);
  });

  it('is gone when its last run leaves, and kept while one remains', async () => {
    await joinBrowserHandoff(redis, waitOn('step-1'));
    await joinBrowserHandoff(redis, waitOn('step-2'));

    const stepOne = {
      key: KEY,
      installationId: 'install-a',
      tenantId: TENANT,
      spaceId: SPACE,
      stepExecutionId: 'step-1',
    };
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
      installationId: 'install-a',
      tenantId: TENANT,
      spaceId: SPACE,
      stepExecutionId: 'step-1',
    });
    expect(await readSpaceBrowserHandoffs(redis, TENANT, SPACE)).toEqual([]);
    const theirs = await readSpaceBrowserHandoffs(redis, TENANT, OTHER_SPACE);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.message).toBe('Sign in for step-9.');
    expect(await redis.hvals(KEY)).not.toContain('Sign in for step-1.');
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

describe('a hand-off whose every run has stopped waiting', () => {
  it('is begun again by the next run: its reason, start, words and runs, not the dead one’s', async () => {
    const now = Date.now();
    await joinBrowserHandoff(redis, {
      ...waitOn('step-dead', { deadlineAt: now - MINUTE }, now - 16 * MINUTE),
      reason: 'challenge',
    });
    expect(await redis.exists(KEY)).toBe(1);

    await joinBrowserHandoff(redis, waitOn('step-new', {}, now));

    const [open] = await readSpaceBrowserHandoffs(redis, TENANT, SPACE);
    expect(open?.reason).toBe('sign_in');
    expect(open?.startedAt).toBe(new Date(now).toISOString());
    expect(open?.message).toBe('Sign in for step-new.');
    expect(open?.waiting.map((w) => w.stepExecutionId)).toEqual(['step-new']);
    const expiresIn = 15 * MINUTE + BROWSER_HANDOFF_EXPIRY_MARGIN_MS;
    expect(await redis.pttl(KEY)).toBeLessThanOrEqual(expiresIn);
  });

  it('keeps the first run’s reason and start while one of its runs may still be waiting', async () => {
    const now = Date.now();
    await joinBrowserHandoff(redis, {
      ...waitOn('step-1', {}, now - MINUTE),
      reason: 'challenge',
    });
    await joinBrowserHandoff(redis, waitOn('step-2', {}, now));

    const [open] = await readSpaceBrowserHandoffs(redis, TENANT, SPACE);
    expect(open?.reason).toBe('challenge');
    expect(open?.startedAt).toBe(new Date(now - MINUTE).toISOString());
    expect(open?.waiting.map((w) => w.stepExecutionId).sort()).toEqual(['step-1', 'step-2']);
  });
});

describe('an installation’s own hand-offs', () => {
  const MACHINE = browserHandoffMachineIndexKey('install-a');

  it('are indexed under the installation while a run waits, and leave it with the last one', async () => {
    await joinBrowserHandoff(redis, waitOn('step-1'));
    expect(await redis.zrange(MACHINE, 0, 9)).toEqual([KEY]);
    expect(await redis.pttl(MACHINE)).toBeGreaterThan(0);

    await leaveBrowserHandoff(redis, {
      key: KEY,
      installationId: 'install-a',
      tenantId: TENANT,
      spaceId: SPACE,
      stepExecutionId: 'step-1',
    });
    expect(await redis.zcard(MACHINE)).toBe(0);
  });

  it('are all taken down by the start-up clear, from every space, and no other installation’s, though it shows the same machine name', async () => {
    await joinBrowserHandoff(redis, waitOn('step-1'));
    await joinBrowserHandoff(redis, { ...waitOn('step-2'), site: 'example.org' });
    await joinBrowserHandoff(redis, waitOn('step-9', { spaceId: OTHER_SPACE }));
    await joinBrowserHandoff(redis, { ...waitOn('step-d'), installationId: 'install-b' });

    const spaces = await clearMachineBrowserHandoffs(redis, 'install-a');

    expect(spaces).toEqual(
      expect.arrayContaining([
        { tenantId: TENANT, spaceId: SPACE },
        { tenantId: TENANT, spaceId: OTHER_SPACE },
      ]),
    );
    expect(spaces).toHaveLength(2);
    expect(await redis.exists(KEY)).toBe(0);
    expect(await redis.exists(browserHandoffKey('install-a', 'default', 'example.org'))).toBe(0);
    expect(await redis.zcard(MACHINE)).toBe(0);
    expect(await readSpaceBrowserHandoffs(redis, TENANT, OTHER_SPACE)).toEqual([]);
    const left = await readSpaceBrowserHandoffs(redis, TENANT, SPACE);
    expect(left.map(({ installationId, machineLabel }) => [installationId, machineLabel])).toEqual([
      ['install-b', 'laptop'],
    ]);
    expect(await redis.zcard(browserHandoffSpaceIndexKey(TENANT, SPACE))).toBe(1);
  });

  it('are cleared in batches, however many an installation left', async () => {
    const count = BROWSER_HANDOFF_CLEAR_BATCH + 3;
    for (let at = 0; at < count; at++) {
      await joinBrowserHandoff(redis, {
        ...waitOn(`step-${String(at)}`),
        site: `site${String(at)}.com`,
      });
    }
    expect(await redis.zcard(MACHINE)).toBe(count);

    await clearMachineBrowserHandoffs(redis, 'install-a');

    expect(await redis.zcard(MACHINE)).toBe(0);
    expect(await redis.zcard(browserHandoffSpaceIndexKey(TENANT, SPACE))).toBe(0);
  });

  it('is nothing to clear for an installation that left none', async () => {
    expect(await clearMachineBrowserHandoffs(redis, 'install-a')).toEqual([]);
  });
});
