/**
 * OAuth-consent reason mapping for the API 3-legged path (Plan 185 §7 / §9.3).
 *
 * Mirrors the MCP executor's `oauthConsentMapping.test.ts`: the split between a
 * recoverable "connect your account" PAUSE and a real FAILED step is made
 * entirely by `apiOAuthConsentReasonFromError`. A mis-mapping is the difference
 * between a parked consent card and a dead run, so the table is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { ApiBindingSchema, type ApiBinding } from '@aflow/schemas';
import { apiOAuthConsentReasonFromError, buildApiOAuthConsentRequest } from './oauth2AuthCode.js';

function authCodeBinding(overrides: Partial<ApiBinding> = {}): ApiBinding {
  return ApiBindingSchema.parse({
    bindingId: 'bnd-1',
    apiId: 'github',
    name: 'GitHub',
    scope: { tenantId: 't-1', spaceId: 'sp-1' },
    auth: {
      type: 'oauth2_authorization_code',
      ownerScope: 'user',
      clientScope: 'tenant',
      issuerKey: 'github.com',
    },
    egressPolicy: { allowedHosts: ['api.github.com'] },
    enabled: true,
    ...overrides,
  });
}

describe('apiOAuthConsentReasonFromError', () => {
  it('maps a missing-token error to never_connected (the owner never consented)', () => {
    expect(apiOAuthConsentReasonFromError(new Error('oauth_no_token: no stored token'))).toBe(
      'never_connected',
    );
  });

  it('maps an unusable-token-with-no-refresh error to expired (re-consent required)', () => {
    expect(
      apiOAuthConsentReasonFromError(
        new Error('oauth_force_refresh_no_refresh_token: cannot refresh'),
      ),
    ).toBe('expired');
  });

  it('matches on the message prefix, not exact equality', () => {
    expect(apiOAuthConsentReasonFromError(new Error('oauth_no_token'))).toBe('never_connected');
    expect(apiOAuthConsentReasonFromError(new Error('oauth_force_refresh_no_refresh_token'))).toBe(
      'expired',
    );
  });

  it('returns null for a genuine resolution fault (→ the step FAILs, not PAUSEs)', () => {
    expect(apiOAuthConsentReasonFromError(new Error('oauth_refresh_failed: 500'))).toBeNull();
    expect(apiOAuthConsentReasonFromError(new Error('oauth_client_not_registered'))).toBeNull();
  });

  it('returns null for non-Error throws that are not token conditions', () => {
    expect(apiOAuthConsentReasonFromError('some string')).toBeNull();
    expect(apiOAuthConsentReasonFromError({ code: 'WHATEVER' })).toBeNull();
    expect(apiOAuthConsentReasonFromError(undefined)).toBeNull();
  });
});

describe('buildApiOAuthConsentRequest', () => {
  it('builds an api oauth_consent payload keyed by apiId (resourceKey), not the binding', () => {
    const binding = authCodeBinding({ apiId: 'github', bindingId: 'bnd-github' });
    const consent = buildApiOAuthConsentRequest(binding.apiId, binding, 'user', 'never_connected');
    expect(consent).toEqual({
      kind: 'oauth_consent',
      integrationKind: 'api',
      resourceKey: 'github',
      bindingId: 'bnd-github',
      ownerScope: 'user',
      consentUrlHint: '/v1/integrations/api/bindings/bnd-github/consent',
      reason: 'never_connected',
    });
  });

  it('carries the reason through unchanged (expired → reconnect)', () => {
    const binding = authCodeBinding();
    const consent = buildApiOAuthConsentRequest(binding.apiId, binding, 'user', 'expired');
    expect(consent.reason).toBe('expired');
  });

  it('reflects the requested ownerScope (space-scoped binding)', () => {
    const binding = authCodeBinding();
    const consent = buildApiOAuthConsentRequest(binding.apiId, binding, 'space', 'never_connected');
    expect(consent.ownerScope).toBe('space');
  });
});
