/**
 * preferredSpace helpers — guard tests.
 *
 * Vitest can't easily simulate next/headers cookie store from a unit
 * test, so we stub it at module-load time. The test scope is the
 * **validation gates** around read/write — does a malformed cookie
 * resolve to null, does set() throw on garbage? The actual cookie
 * write surface is exercised by Next.js itself in integration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeStore {
  store: Map<string, string>;
  get(name: string): { value: string } | undefined;
  set(opts: { name: string; value: string }): void;
  delete(name: string): void;
}

const fakeCookieStore: FakeStore = {
  store: new Map(),
  get(name: string) {
    const value = this.store.get(name);
    return value === undefined ? undefined : { value };
  },
  set(opts: { name: string; value: string }) {
    this.store.set(opts.name, opts.value);
  },
  delete(name: string) {
    this.store.delete(name);
  },
};

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(fakeCookieStore),
}));

beforeEach(() => {
  fakeCookieStore.store.clear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('preferredSpace cookie helpers', () => {
  it('round-trips a valid slug', async () => {
    const { setPreferredSpaceSlug, getPreferredSpaceSlug } = await import('./preferredSpace.js');
    await setPreferredSpaceSlug('acme-corp');
    expect(await getPreferredSpaceSlug()).toBe('acme-corp');
  });

  it('returns null when no cookie is set', async () => {
    const { getPreferredSpaceSlug } = await import('./preferredSpace.js');
    expect(await getPreferredSpaceSlug()).toBeNull();
  });

  it('returns null when the cookie value is malformed (tampered)', async () => {
    fakeCookieStore.store.set('preferredSpaceSlug', 'NOT-A-VALID-SLUG');
    const { getPreferredSpaceSlug } = await import('./preferredSpace.js');
    expect(await getPreferredSpaceSlug()).toBeNull();
  });

  it('returns null when the cookie value is empty', async () => {
    fakeCookieStore.store.set('preferredSpaceSlug', '');
    const { getPreferredSpaceSlug } = await import('./preferredSpace.js');
    expect(await getPreferredSpaceSlug()).toBeNull();
  });

  it('returns null when the cookie value looks like a UUID (defensive)', async () => {
    fakeCookieStore.store.set('preferredSpaceSlug', '00000000-0000-0000-0000-000000000001');
    const { getPreferredSpaceSlug } = await import('./preferredSpace.js');
    expect(await getPreferredSpaceSlug()).toBeNull();
  });

  it('throws when setPreferredSpaceSlug is called with an invalid slug', async () => {
    const { setPreferredSpaceSlug } = await import('./preferredSpace.js');
    await expect(setPreferredSpaceSlug('NOT_A_SLUG')).rejects.toThrow();
  });

  it('clear removes the cookie', async () => {
    fakeCookieStore.store.set('preferredSpaceSlug', 'general');
    const { clearPreferredSpaceSlug, getPreferredSpaceSlug } = await import('./preferredSpace.js');
    await clearPreferredSpaceSlug();
    expect(await getPreferredSpaceSlug()).toBeNull();
  });
});
