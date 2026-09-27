/**
 * What a connect token must be, given what it replaced: an instruction to paste
 * the credential that authenticates as the owner for every call this API has.
 * A replacement is only an improvement if it is genuinely narrower and genuinely
 * short-lived, so those are the properties under test rather than the happy path.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { TenantId } from '@aflow/schemas';

const store = new Map<string, { value: string; ttl: number }>();
vi.mock('@aflow/redis', () => ({
  getRedisConnection: () => ({
    setex: (key: string, ttl: number, value: string) => {
      store.set(key, { value, ttl });
      return Promise.resolve('OK');
    },
    get: (key: string) => Promise.resolve(store.get(key)?.value ?? null),
    del: (key: string) => Promise.resolve(store.delete(key) ? 1 : 0),
  }),
}));

const { mintConnectToken, redeemConnectToken, normalize } = await import('./hostConnectToken.js');

const grant = {
  tenantId: 'a0000000-0000-0000-0000-000000000001' as TenantId,
  spaceId: 'space-1',
  spaceSlug: 'my-space',
};

beforeEach(() => {
  store.clear();
});

describe('a connect token', () => {
  it('carries the space it was minted for, and nothing wider', async () => {
    const { code } = await mintConnectToken(grant);
    expect(await redeemConnectToken(code)).toEqual(grant);
  });

  it('is spent by the first redemption', async () => {
    const { code } = await mintConnectToken(grant);
    expect(await redeemConnectToken(code)).toEqual(grant);
    // The whole reason a code can be read aloud, pasted into a chat, or left in
    // scrollback without much regret.
    expect(await redeemConnectToken(code)).toBeNull();
  });

  it('expires on its own, without anything having to sweep it', async () => {
    await mintConnectToken(grant);
    const [entry] = [...store.values()];
    expect(entry?.ttl).toBeGreaterThan(0);
    expect(entry?.ttl).toBeLessThanOrEqual(15 * 60);
  });

  it('is not stored in a form that could be used', async () => {
    const { code } = await mintConnectToken(grant);
    // A Redis dump should not be a list of working codes.
    for (const key of store.keys()) expect(key).not.toContain(normalize(code));
  });

  it('refuses a code that was never minted, saying nothing about why', async () => {
    expect(await redeemConnectToken('AAAAA-AAAAA')).toBeNull();
    expect(await redeemConnectToken('')).toBeNull();
    expect(await redeemConnectToken('nonsense')).toBeNull();
  });

  it('is forgiving about how the operator typed it', async () => {
    const { code } = await mintConnectToken(grant);
    // Read off one screen and typed into another. Case and the grouping hyphen
    // are presentation, and failing on them teaches the operator nothing.
    expect(await redeemConnectToken(code.toLowerCase().replace('-', ''))).toEqual(grant);
  });

  it('avoids the characters that get transcribed wrong', async () => {
    for (let i = 0; i < 40; i += 1) {
      const { code } = await mintConnectToken(grant);
      expect(code).not.toMatch(/[01OIL]/);
    }
  });
});
