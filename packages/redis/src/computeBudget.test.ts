import { describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { reserveComputeSeconds, settleComputeSeconds } from './computeBudget.js';

const redis = new RedisMock() as unknown as Redis;

const tenant = (): string => `t-${Math.random().toString(36).slice(2)}`;

describe('reserveComputeSeconds', () => {
  it('skips redis entirely when no limits are configured', async () => {
    const out = await reserveComputeSeconds(redis, {
      tenantId: tenant(),
      spaceId: 's1',
      seconds: 1800,
      limits: {},
    });
    expect(out).toMatchObject({ allowed: true, exceededScope: null, limitSeconds: null });
  });

  it('allows under the per-space bound and refuses over it', async () => {
    const tenantId = tenant();
    const limits = { perSpaceSeconds: 600 };
    const first = await reserveComputeSeconds(redis, {
      tenantId,
      spaceId: 's1',
      seconds: 500,
      limits,
    });
    expect(first.allowed).toBe(true);

    const second = await reserveComputeSeconds(redis, {
      tenantId,
      spaceId: 's1',
      seconds: 500,
      limits,
    });
    expect(second).toMatchObject({ allowed: false, exceededScope: 'space', limitSeconds: 600 });

    // A different space has its own counter.
    const other = await reserveComputeSeconds(redis, {
      tenantId,
      spaceId: 's2',
      seconds: 500,
      limits,
    });
    expect(other.allowed).toBe(true);
  });

  it('the tenant backstop refuses across spaces', async () => {
    const tenantId = tenant();
    const limits = { perSpaceSeconds: 10_000, tenantSeconds: 900 };
    await reserveComputeSeconds(redis, { tenantId, spaceId: 's1', seconds: 600, limits });
    const out = await reserveComputeSeconds(redis, {
      tenantId,
      spaceId: 's2',
      seconds: 600,
      limits,
    });
    expect(out).toMatchObject({ allowed: false, exceededScope: 'tenant', limitSeconds: 900 });
  });

  it('releases a refused reservation so repeated refusals do not inflate the counter', async () => {
    const tenantId = tenant();
    const limits = { perSpaceSeconds: 600 };
    await reserveComputeSeconds(redis, { tenantId, spaceId: 's1', seconds: 500, limits });

    // Three oversized attempts, each refused and each released.
    for (let i = 0; i < 3; i++) {
      const refused = await reserveComputeSeconds(redis, {
        tenantId,
        spaceId: 's1',
        seconds: 500,
        limits,
      });
      expect(refused.allowed).toBe(false);
    }

    // 100s of headroom survived the refusals.
    const fits = await reserveComputeSeconds(redis, {
      tenantId,
      spaceId: 's1',
      seconds: 100,
      limits,
    });
    expect(fits.allowed).toBe(true);
  });

  it('null spaceId applies only the tenant bound', async () => {
    const out = await reserveComputeSeconds(redis, {
      tenantId: tenant(),
      spaceId: null,
      seconds: 100,
      limits: { perSpaceSeconds: 1 },
    });
    expect(out.allowed).toBe(true);
  });
});

describe('settleComputeSeconds', () => {
  it('refunds the unused reservation so a later call fits', async () => {
    const tenantId = tenant();
    const limits = { perSpaceSeconds: 600 };

    // Reserve the full 500s timeout, but the call only ran 5s.
    const reserved = await reserveComputeSeconds(redis, {
      tenantId,
      spaceId: 's1',
      seconds: 500,
      limits,
    });
    expect(reserved.allowed).toBe(true);
    await settleComputeSeconds(redis, {
      tenantId,
      spaceId: 's1',
      reservedSeconds: 500,
      actualSeconds: 5,
      limits,
      day: reserved.day,
    });

    // Without the refund only 100s would remain; with it, 595s do.
    const next = await reserveComputeSeconds(redis, {
      tenantId,
      spaceId: 's1',
      seconds: 500,
      limits,
    });
    expect(next.allowed).toBe(true);
  });

  it('refunds nothing when the call consumed its whole reservation', async () => {
    const tenantId = tenant();
    const limits = { perSpaceSeconds: 600 };
    const reserved = await reserveComputeSeconds(redis, {
      tenantId,
      spaceId: 's1',
      seconds: 500,
      limits,
    });
    await settleComputeSeconds(redis, {
      tenantId,
      spaceId: 's1',
      reservedSeconds: 500,
      actualSeconds: 500,
      limits,
      day: reserved.day,
    });
    const next = await reserveComputeSeconds(redis, {
      tenantId,
      spaceId: 's1',
      seconds: 200,
      limits,
    });
    expect(next).toMatchObject({ allowed: false, exceededScope: 'space', limitSeconds: 600 });
  });

  it('refunds the bucket the reservation charged, not the one current at settle', async () => {
    // A call spanning UTC midnight settles while the clock already reads the
    // next day. Following the clock would leave the charged day fully consumed
    // and drive the new day's counter negative, letting it overrun its quota.
    // Standing in for that here: settle a bucket that is deliberately not
    // today's and assert the refund lands where it was charged.
    const tenantId = tenant();
    const limits = { perSpaceSeconds: 600 };
    const chargedDay = '2999-12-30';
    const spaceKey = (day: string): string => `aflow:compute-budget:${tenantId}:space:s1:${day}`;

    await redis.incrby(spaceKey(chargedDay), 500);
    const today = (
      await reserveComputeSeconds(redis, { tenantId, spaceId: 's1', seconds: 10, limits })
    ).day;
    expect(today).not.toBe(chargedDay);

    await settleComputeSeconds(redis, {
      tenantId,
      spaceId: 's1',
      reservedSeconds: 500,
      actualSeconds: 5,
      limits,
      day: chargedDay,
    });

    // The named bucket absorbed the 495s refund...
    expect(Number(await redis.get(spaceKey(chargedDay)))).toBe(5);
    // ...and today's counter kept only its own 10s reservation.
    expect(Number(await redis.get(spaceKey(today)))).toBe(10);
  });

  it('touches nothing when no limits are configured', async () => {
    await expect(
      settleComputeSeconds(redis, {
        tenantId: tenant(),
        spaceId: 's1',
        reservedSeconds: 500,
        actualSeconds: 5,
        limits: {},
        day: '2026-09-16',
      }),
    ).resolves.toBeUndefined();
  });
});
