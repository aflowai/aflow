/**
 * 3-legged (authorization-code) OAuth for the API executor.
 *
 * The executor never holds the credential keys (the OAuth client secret and
 * the user's tokens live in `oauth_tokens` / `oauth_clients`, written
 * server-side). It resolves a valid access token through the shared
 * `@aflow/oauth` `getValidAccessToken` authority — keyed by the binding's
 * pinned `(integrationKind='api', resourceKey=apiId, ownerScope, ownerId,
 * clientScope, issuerKey)` — and injects `Authorization: Bearer`.
 *
 * When the pinned owner has no usable token (`needsConsent`, `oauth_no_token`,
 * or a force-refresh with no refresh token), this is NOT a failure: it surfaces
 * the SAME `oauth_consent` request payload the MCP executor parks on, so the
 * caller can turn it into the recoverable "Connect your account" pause
 * (Plan 185 §9.3). The mapping/consent helpers mirror the MCP handler's private
 * ones; the shared infra (the `OAuthConsentRequestPayload` schema, the
 * `getValidAccessToken` token authority, and `pausedWithRequest`) is reused.
 */
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { ApiBinding, OAuthConsentRequestPayload, OAuthConsentReason } from '@aflow/schemas';
import { getValidAccessToken, resolveOAuthOwner, type OAuthBindingTarget } from '@aflow/oauth';

type AuthCodeProfile = Extract<ApiBinding['auth'], { type: 'oauth2_authorization_code' }>;

/**
 * Thrown by {@link resolveOAuth2AuthCodeToken} when the pinned owner has no
 * usable token. Caught at the `ApiCallHandler` boundary, which converts the
 * carried payload into a `pausedWithRequest` PAUSE rather than a FAILED step.
 */
export class ApiOAuthConsentRequired extends Error {
  readonly consent: OAuthConsentRequestPayload;

  constructor(consent: OAuthConsentRequestPayload) {
    super(`oauth_consent_required: ${consent.resourceKey} (${consent.reason})`);
    this.name = 'ApiOAuthConsentRequired';
    this.consent = consent;
  }
}

/**
 * Map a `getValidAccessToken` failure to a consent `reason`, or `null` when the
 * error is a genuine resolution fault that should still FAIL. Mirrors the MCP
 * handler's `oauthConsentReasonFromError`.
 */
export function apiOAuthConsentReasonFromError(err: unknown): OAuthConsentReason | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('oauth_no_token')) return 'never_connected';
  if (message.startsWith('oauth_force_refresh_no_refresh_token')) return 'expired';
  return null;
}

export function buildApiOAuthConsentRequest(
  apiId: string,
  binding: ApiBinding,
  ownerScope: AuthCodeProfile['ownerScope'],
  reason: OAuthConsentReason,
): OAuthConsentRequestPayload {
  return {
    kind: 'oauth_consent',
    integrationKind: 'api',
    resourceKey: apiId,
    bindingId: binding.bindingId,
    ownerScope,
    consentUrlHint: `/v1/integrations/api/bindings/${binding.bindingId}/consent`,
    reason,
  };
}

interface ResolveAuthCodeTokenArgs {
  ctx: ExecutorContext;
  db: unknown;
  apiId: string;
  binding: ApiBinding;
  auth: AuthCodeProfile;
  spaceId: string;
}

/**
 * Resolve a valid `Authorization` header value (`<tokenType> <accessToken>`)
 * for an `oauth2_authorization_code` binding, or throw {@link
 * ApiOAuthConsentRequired} when the owner must (re)connect.
 *
 * The executor is stateless: it delegates refresh + writeback entirely to
 * `getValidAccessToken` (the single server-side token authority) and never
 * writes the encrypted store itself.
 */
export async function resolveOAuth2AuthCodeToken(args: ResolveAuthCodeTokenArgs): Promise<string> {
  const { ctx, db, apiId, binding, auth, spaceId } = args;

  if (!db) {
    throw new Error(
      `Binding "${binding.bindingId}" oauth2_authorization_code requires a database connection in the executor (oauth tokens persist in oauth_tokens).`,
    );
  }

  // Pinned identity resolution (Plan 185 D4): ownerScope selects exactly one
  // owner — `user` pins the run's credentialOwnerId, never a fallback to the
  // tenant. A user-scoped run with no user identity becomes a recoverable
  // consent PAUSE, not a FAILED step.
  const credentialOwnerId = (ctx.job as Record<string, unknown>)['credentialOwnerId'] as
    string | undefined;
  const ownerResult = resolveOAuthOwner(auth.ownerScope, {
    ...(credentialOwnerId ? { userId: credentialOwnerId } : {}),
    spaceId,
    tenantId: ctx.job.tenantId,
  });
  if ('needsConsent' in ownerResult) {
    throw new ApiOAuthConsentRequired(
      buildApiOAuthConsentRequest(apiId, binding, auth.ownerScope, 'never_connected'),
    );
  }

  const target: OAuthBindingTarget = {
    integrationKind: 'api',
    resourceKey: apiId,
    bindingId: binding.bindingId,
    ownerScope: auth.ownerScope,
    ownerId: ownerResult.ownerId,
    clientScope: auth.clientScope,
    issuerKey: auth.issuerKey,
    ...(auth.authorizationServer ? { authorizationServer: auth.authorizationServer } : {}),
  };

  try {
    const result = await getValidAccessToken({
      tenantId: ctx.job.tenantId,
      spaceId,
      target,
      db,
    });
    return `${result.tokenType || 'Bearer'} ${result.accessToken}`;
  } catch (err) {
    const consentReason = apiOAuthConsentReasonFromError(err);
    if (consentReason) {
      throw new ApiOAuthConsentRequired(
        buildApiOAuthConsentRequest(apiId, binding, auth.ownerScope, consentReason),
      );
    }
    throw err;
  }
}
