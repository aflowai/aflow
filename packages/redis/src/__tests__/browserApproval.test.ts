import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';

import {
  browserApprovalSpentKey,
  browserAskKey,
  readBrowserAsk,
  rememberBrowserAsk,
  spendBrowserApproval,
} from '../browserApproval.js';
import { setWriteApprovalGrant, writeApprovalGrantKey } from '../writeApproval.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN = 'run-1';

let redis: RedisType;

beforeEach(async () => {
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
});

afterEach(() => {
  redis.disconnect();
});

describe('a browser approval', () => {
  it('is spent once, and a later approval of the same request is a new one to spend', async () => {
    const first = { requestHash: 'h1', decidedAt: '2026-10-04T12:00:00.000Z' };
    expect(await spendBrowserApproval(redis, TENANT, RUN, first)).toBe(true);
    expect(await spendBrowserApproval(redis, TENANT, RUN, first)).toBe(false);

    const second = { ...first, decidedAt: '2026-10-04T12:05:00.000Z' };
    expect(await spendBrowserApproval(redis, TENANT, RUN, second)).toBe(true);
    expect(await spendBrowserApproval(redis, 'other-tenant', RUN, first)).toBe(true);
  });

  it('outlives the grant it marks', async () => {
    await setWriteApprovalGrant(redis, TENANT, RUN, {
      requestHash: 'h1',
      decision: 'approved',
      decidedAt: '2026-10-04T12:00:00.000Z',
    });
    await spendBrowserApproval(redis, TENANT, RUN, {
      requestHash: 'h1',
      decidedAt: '2026-10-04T12:00:00.000Z',
    });
    const grantTtl = await redis.ttl(writeApprovalGrantKey(TENANT, RUN, 'h1'));
    const spentTtl = await redis.ttl(
      browserApprovalSpentKey(TENANT, RUN, {
        requestHash: 'h1',
        decidedAt: '2026-10-04T12:00:00.000Z',
      }),
    );
    expect(spentTtl).toBeGreaterThanOrEqual(grantTtl);
  });

  it('remembers which request a call was parked on, by run', async () => {
    await rememberBrowserAsk(redis, TENANT, RUN, 'call-1', 'h1');
    expect(await readBrowserAsk(redis, TENANT, RUN, 'call-1')).toBe('h1');
    expect(await readBrowserAsk(redis, TENANT, 'run-2', 'call-1')).toBeNull();
  });

  it('keeps its records outside the grant family the host identity may only read', () => {
    for (const key of [
      browserAskKey(TENANT, RUN, 'call-1'),
      browserApprovalSpentKey(TENANT, RUN, { requestHash: 'h1' }),
    ]) {
      expect(key.startsWith('aflow:browser-ask:')).toBe(true);
    }
    expect(writeApprovalGrantKey(TENANT, RUN, 'h1').startsWith('aflow:browser-ask:')).toBe(false);
  });
});
