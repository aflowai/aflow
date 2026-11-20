import { describe, it, expect } from 'vitest';
import {
  oauthAppsPageForScope,
  oauthDefaultClientScopeChoices,
  oauthDefaultClientScopeForEdition,
} from './policy.js';

describe('edition-aware default OAuth app', () => {
  it('starts a local tenant on the tenant client', () => {
    expect(oauthDefaultClientScopeForEdition('community-local')).toBe('tenant');
    expect(oauthDefaultClientScopeChoices('community-local')).toEqual(['tenant']);
  });

  it('keeps the hosted default on the space client', () => {
    expect(oauthDefaultClientScopeForEdition('enterprise')).toBe('space');
    expect(oauthDefaultClientScopeChoices('enterprise')).toEqual(['platform', 'tenant', 'space']);
  });

  it('starts every edition on a default it offers', () => {
    for (const edition of ['community-local', 'enterprise'] as const) {
      expect(oauthDefaultClientScopeChoices(edition)).toContain(
        oauthDefaultClientScopeForEdition(edition),
      );
    }
  });

  it('names no space OAuth Apps page in the local edition', () => {
    expect(oauthAppsPageForScope('community-local', 'space')).toBeNull();
    expect(oauthAppsPageForScope('community-local', 'tenant')).toMatch(/^Settings → OAuth Apps/);
    expect(oauthAppsPageForScope('enterprise', 'space')).toBe('the space’s Settings → OAuth Apps');
  });
});
