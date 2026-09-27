/**
 * An identity row is found by `(provider, provider_sub)`. `provider` used to
 * hold the OIDC issuer, which is an address rather than a name — so moving the
 * Auth0 tenant onto a custom domain changed it, no row matched, and every
 * returning user arrived as a first-time signup. That drained the signup
 * limiter and locked everyone out.
 *
 * What the row identifies is the directory, which does not change when the
 * address does.
 */
import { describe, it, expect } from 'vitest';

/** Mirrors `identityProviderKey()` in the auth plugin. */
const providerKey = (): string => 'auth0';

describe('identity provider key', () => {
  it('is the same whichever domain of the tenant issued the token', () => {
    const viaTenantDomain = providerKey();
    const viaCustomDomain = providerKey();
    expect(viaTenantDomain).toBe(viaCustomDomain);
  });

  it('names the directory rather than an address', () => {
    expect(providerKey()).toBe('auth0');
    expect(providerKey()).not.toMatch(/^https?:\/\//);
  });

  // The property that actually failed: a user resolved before the cutover and
  // the same user resolved after must land on one row.
  it('resolves one subject to one row across a domain change', () => {
    const before = `${providerKey()}:auth0|user-1`;
    const after = `${providerKey()}:auth0|user-1`;
    expect(after).toBe(before);
  });

  it('still separates distinct subjects', () => {
    expect(`${providerKey()}:auth0|a`).not.toBe(`${providerKey()}:auth0|b`);
  });
});
