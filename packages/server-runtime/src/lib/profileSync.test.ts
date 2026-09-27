/**
 * The learned address is the marker that says "this account has been
 * repaired", so it may only be written once the repair actually happened.
 * Committing it first turns a transient redemption failure into a permanent
 * one: the next login sees a matching address, schedules no repair, and the
 * grants stay pending forever with nothing left to retry them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { FastifyBaseLogger } from 'fastify';
import type { UserId } from '@aflow/schemas';

const mocks = vi.hoisted(() => ({
  redeemSpaceGrantsForVerifiedEmail: vi.fn(async (_args: unknown) => Promise.resolve()),
}));
vi.mock('../services/spaceGrants.js', () => ({
  redeemSpaceGrantsForVerifiedEmail: mocks.redeemSpaceGrantsForVerifiedEmail,
}));

const { syncUserProfile } = await import('./profileSync.js');

const USER_ID = '00000000-0000-4000-8000-0000000000aa' as UserId;
const CACHE_KEY = 'aflow:identity:auth0:google-oauth2|1';

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;

/** Records the order of writes so the sequence itself can be asserted. */
function makeFakeDb(calls: string[]) {
  return {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          calls.push(`update:${Object.keys(values).sort().join(',')}`);
          return Promise.resolve(undefined);
        },
      }),
    }),
  } as unknown as PostgresJsDatabase;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redeemSpaceGrantsForVerifiedEmail.mockImplementation(async () => Promise.resolve());
});

describe('syncUserProfile', () => {
  it('redeems grants before committing the learned address', async () => {
    const calls: string[] = [];
    mocks.redeemSpaceGrantsForVerifiedEmail.mockImplementation(async () => {
      calls.push('redeem');
      return Promise.resolve();
    });

    await syncUserProfile({
      db: makeFakeDb(calls),
      redis: null,
      log,
      userId: USER_ID,
      identityCacheKey: CACHE_KEY,
      profile: { email: 'user@example.com' },
    });

    expect(calls).toEqual(['redeem', 'update:email']);
  });

  it('leaves the address unwritten when redemption fails, so the next login retries', async () => {
    const calls: string[] = [];
    mocks.redeemSpaceGrantsForVerifiedEmail.mockRejectedValue(new Error('postgres unavailable'));

    await syncUserProfile({
      db: makeFakeDb(calls),
      redis: null,
      log,
      userId: USER_ID,
      identityCacheKey: CACHE_KEY,
      profile: { email: 'user@example.com' },
    });

    expect(calls).toEqual([]);
    expect(log.error).toHaveBeenCalled();
  });

  it('still fills a default display name when redemption fails', async () => {
    const calls: string[] = [];
    mocks.redeemSpaceGrantsForVerifiedEmail.mockRejectedValue(new Error('postgres unavailable'));

    await syncUserProfile({
      db: makeFakeDb(calls),
      redis: null,
      log,
      userId: USER_ID,
      identityCacheKey: CACHE_KEY,
      profile: { email: 'user@example.com', displayName: 'Ada' },
    });

    expect(calls).toEqual(['update:displayName']);
  });

  it('does not redeem for a profile that carries no address', async () => {
    const calls: string[] = [];

    await syncUserProfile({
      db: makeFakeDb(calls),
      redis: null,
      log,
      userId: USER_ID,
      identityCacheKey: CACHE_KEY,
      profile: { avatarUrl: 'https://cdn.example/a.png' },
    });

    expect(mocks.redeemSpaceGrantsForVerifiedEmail).not.toHaveBeenCalled();
    expect(calls).toEqual(['update:avatarUrl']);
  });

  it('drops the stale identity cache entry after a successful write', async () => {
    const deleted: string[] = [];
    const redis = { del: async (key: string) => (deleted.push(key), Promise.resolve(1)) };

    await syncUserProfile({
      db: makeFakeDb([]),
      redis: redis as unknown as null,
      log,
      userId: USER_ID,
      identityCacheKey: CACHE_KEY,
      profile: { email: 'user@example.com' },
    });

    expect(deleted).toEqual([CACHE_KEY]);
  });
});
