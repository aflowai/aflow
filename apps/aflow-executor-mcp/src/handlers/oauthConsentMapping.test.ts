/**
 * OAuth-consent reason mapping (Plan 185 §9.3 Plane A).
 *
 * `buildAuthHeaders` turns a `getValidAccessToken` failure into either a
 * recoverable consent PAUSE (the owner must connect / reconnect) or a real
 * FAILED step. The split is made entirely by `oauthConsentReasonFromError`:
 *   - `oauth_no_token*`                       → 'never_connected' → PAUSE
 *   - `oauth_force_refresh_no_refresh_token*` → 'expired'         → PAUSE
 *   - anything else                           → null              → FAILED
 *
 * A mis-mapping here is the difference between a parked "connect your account"
 * card and a dead run, so the table is pinned directly.
 */
import { describe, it, expect } from 'vitest';
import { McpServerBindingSchema, type McpServerBinding } from '@aflow/schemas';
import { oauthConsentReasonFromError, buildOAuthConsentRequest } from './mcpHandler.js';

function oauthBinding(overrides: Partial<McpServerBinding> = {}): McpServerBinding {
  return McpServerBindingSchema.parse({
    bindingId: 'bnd-1',
    serverId: 'srv-1',
    name: 'Test server',
    scope: { tenantId: 't-1', spaceId: 'sp-1' },
    auth: { type: 'oauth2_pkce' },
    ownerScope: 'user',
    clientScope: 'platform',
    pinnedOrigin: 'https://example.com',
    enabled: true,
    ...overrides,
  });
}

describe('oauthConsentReasonFromError', () => {
  it('maps a missing-token error to never_connected (the owner never consented)', () => {
    expect(oauthConsentReasonFromError(new Error('oauth_no_token: no stored token'))).toBe(
      'never_connected',
    );
  });

  it('maps an unusable-token-with-no-refresh error to expired (re-consent required)', () => {
    expect(
      oauthConsentReasonFromError(
        new Error('oauth_force_refresh_no_refresh_token: cannot refresh'),
      ),
    ).toBe('expired');
  });

  it('matches on the message prefix, not exact equality', () => {
    expect(oauthConsentReasonFromError(new Error('oauth_no_token'))).toBe('never_connected');
    expect(oauthConsentReasonFromError(new Error('oauth_force_refresh_no_refresh_token'))).toBe(
      'expired',
    );
  });

  it('returns null for a genuine resolution fault (→ the step FAILs, not PAUSEs)', () => {
    expect(oauthConsentReasonFromError(new Error('discovery_failed: PRM unreachable'))).toBeNull();
    expect(oauthConsentReasonFromError(new Error('token endpoint returned 500'))).toBeNull();
  });

  it('returns null for non-Error throws that are not token conditions', () => {
    expect(oauthConsentReasonFromError('some string')).toBeNull();
    expect(oauthConsentReasonFromError({ code: 'WHATEVER' })).toBeNull();
    expect(oauthConsentReasonFromError(undefined)).toBeNull();
  });
});

describe('buildOAuthConsentRequest', () => {
  it('builds an mcp oauth_consent payload pinned to the binding identity', () => {
    const binding = oauthBinding({
      serverId: 'github',
      bindingId: 'bnd-github',
      ownerScope: 'user',
    });
    const consent = buildOAuthConsentRequest(binding, 'never_connected');
    expect(consent).toEqual({
      kind: 'oauth_consent',
      integrationKind: 'mcp',
      resourceKey: 'github',
      bindingId: 'bnd-github',
      ownerScope: 'user',
      consentUrlHint: '/v1/integrations/mcp/bindings/bnd-github/consent',
      reason: 'never_connected',
    });
  });

  it('carries the reason through unchanged (expired → reconnect)', () => {
    const consent = buildOAuthConsentRequest(oauthBinding(), 'expired');
    expect(consent.reason).toBe('expired');
  });

  it('reflects the binding ownerScope (space-scoped binding)', () => {
    const consent = buildOAuthConsentRequest(
      oauthBinding({ ownerScope: 'space' }),
      'never_connected',
    );
    expect(consent.ownerScope).toBe('space');
  });
});
