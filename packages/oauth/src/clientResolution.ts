/**
 * OAuth client (app) resolution — the client/app ownership dimension.
 *
 * Pinned per `clientScope` (never a `platform → tenant → space` walk):
 *   - `platform` → the platform CIMD client (`/.well-known/cimd`); for an MCP
 *     `oauth2_cimd` binding the `client_id` IS the hosted CIMD metadata URL
 *     (SEP-991), carried on `binding.clientIdMetadataUrl`.
 *   - `tenant`   → `oauth_clients` row at `(scope='tenant', scope_id=tenantId, issuer_key)`.
 *   - `space`    → `oauth_clients` row at `(scope='space',  scope_id=spaceId,  issuer_key)`.
 *
 * This is the single client-resolution authority: it consolidates the three
 * duplicated `client_id` sites and the two `client_secret` sites that lived in
 * the token manager, and it eliminates the §1.4 unscoped `api_credentials`
 * read — tenant/space clients are keyed by `(scope, scope_id, issuer_key)`, so
 * there is no arbitrary cross-space `LIMIT 1`.
 */
import { eq, and } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  oauthClients,
  decryptCredentialAsync,
} from '@aflow/database';
import { TenantIdSchema } from '@aflow/schemas';

export type OAuthClientScope = 'platform' | 'tenant' | 'space';

export interface ResolveOAuthClientParams {
  /** Drizzle DB handle. */
  db: unknown;
  tenantId: string;
  spaceId: string;
  clientScope: OAuthClientScope;
  /**
   * Stable per-issuer key disambiguating multiple apps a tenant/space may
   * register. Ignored for `clientScope='platform'`. Typically the resource's
   * authorization-server origin or a curated issuer slug.
   */
  issuerKey: string;
  /**
   * Platform-client identity for the `platform` scope. For an MCP
   * `oauth2_cimd` binding this is the hosted CIMD metadata URL used directly
   * as `client_id` (SEP-991). Required when `clientScope='platform'`.
   */
  platformClientId?: string;
}

export interface ResolveOAuthClientResult {
  clientId: string;
  /** Present only for confidential (tenant/space) clients with a stored secret. */
  clientSecret?: string;
  /** Operator-pinned AS for tenant/space clients; undefined falls back to discovery. */
  authorizationServer?: string;
  /** Default scopes registered with the client (tenant/space clients only). */
  defaultScopes?: string[];
}

/**
 * Resolve the OAuth client (app) for a consent / token-exchange / refresh call.
 * Pinned by `clientScope`; a missing tenant/space client row is a hard config
 * error (no fallback to the platform client).
 */
export async function resolveOAuthClient(
  params: ResolveOAuthClientParams,
): Promise<ResolveOAuthClientResult> {
  if (params.clientScope === 'platform') {
    if (!params.platformClientId) {
      throw new Error(
        'oauth_client_platform_missing_client_id: clientScope="platform" requires a platform client identity (CIMD metadata URL).',
      );
    }
    return { clientId: params.platformClientId };
  }

  const scopeId = params.clientScope === 'tenant' ? params.tenantId : params.spaceId;

  const tenantCtx = createTenantContext(TenantIdSchema.parse(params.tenantId));
  const rows = await withTenantSchema(
    params.db as Parameters<typeof withTenantSchema>[0],
    tenantCtx,
    async (tx) => {
      return tx
        .select({
          clientId: oauthClients.clientId,
          encryptedClientSecret: oauthClients.encryptedClientSecret,
          authorizationServer: oauthClients.authorizationServer,
          defaultScopesJson: oauthClients.defaultScopesJson,
        })
        .from(oauthClients)
        .where(
          and(
            eq(oauthClients.scope, params.clientScope),
            eq(oauthClients.scopeId, scopeId),
            eq(oauthClients.issuerKey, params.issuerKey),
          ),
        )
        .limit(1);
    },
  );

  const row = rows[0];
  if (!row) {
    throw new Error(
      `oauth_client_not_registered: no oauth_clients row at (scope="${params.clientScope}", scopeId="${scopeId}", issuerKey="${params.issuerKey}").`,
    );
  }

  const result: ResolveOAuthClientResult = { clientId: row.clientId };
  if (row.encryptedClientSecret) {
    result.clientSecret = await decryptCredentialAsync(row.encryptedClientSecret);
  }
  if (row.authorizationServer) result.authorizationServer = row.authorizationServer;
  if (row.defaultScopesJson.length > 0) result.defaultScopes = row.defaultScopesJson;
  return result;
}
