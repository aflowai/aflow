import { describe, it, expect } from 'vitest';
import {
  OAUTH_ISSUER_REGISTRY,
  getOAuthIssuer,
  getAllOAuthIssuers,
  getAllOAuthIssuerKeys,
} from './issuerRegistry.js';
import { OAuthIssuerDefinitionSchema } from './issuer.js';

describe('OAuth issuer registry', () => {
  it('seeds the expected curated issuers', () => {
    const keys = getAllOAuthIssuerKeys();
    expect(keys).toContain('google');
    expect(keys).toContain('github');
  });

  it('every entry validates against the schema', () => {
    for (const issuer of OAUTH_ISSUER_REGISTRY) {
      const result = OAuthIssuerDefinitionSchema.safeParse(issuer);
      expect(result.success, `Issuer ${issuer.issuerKey} failed validation`).toBe(true);
    }
  });

  it('getOAuthIssuer returns a known issuer', () => {
    const google = getOAuthIssuer('google');
    expect(google).toBeDefined();
    expect(google!.displayName).toBe('Google');
    expect(google!.incrementalAuth).toBe(true);
  });

  it('getOAuthIssuer returns undefined for an unregistered key (escape hatch is supported)', () => {
    expect(getOAuthIssuer('not-a-real-issuer')).toBeUndefined();
  });

  it('has unique issuer keys', () => {
    const keys = getAllOAuthIssuers().map((i) => i.issuerKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('exposes either a discovery URL or both endpoints, never neither', () => {
    for (const issuer of getAllOAuthIssuers()) {
      const e = issuer.endpoints;
      const hasDiscovery = 'discoveryUrl' in e;
      const hasEndpoints = 'authorizationServer' in e && 'tokenEndpoint' in e;
      expect(
        hasDiscovery || hasEndpoints,
        `Issuer ${issuer.issuerKey} must carry a discovery URL or both endpoints`,
      ).toBe(true);
    }
  });
});
