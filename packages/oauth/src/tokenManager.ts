import { randomBytes, createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { eq, and } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  oauthState as oauthStateTable,
  oauthTokens as oauthTokensTable,
  encryptCredentialEnvelope,
  decryptCredentialAsync,
} from '@aflow/database';
import { TenantIdSchema, extractUrlOrigin, getOAuthIssuer } from '@aflow/schemas';
import { validateCredentialedUrl } from '@aflow/network-safety';
import { discoverPRM, type PrmDiscoveryResult } from './prmDiscovery.js';
import { discoverAsMetadata, type AsMetadata } from './asMetadata.js';
import { resolveOAuthClient, type OAuthClientScope } from './clientResolution.js';
import type { OAuthOwnerScope } from './resolver.js';

// ============================================================================
// Shared vocabulary
// ============================================================================

export type IntegrationKind = 'mcp' | 'api';

/**
 * Discovery descriptor for the MCP path: the manager runs RFC 9728 PRM
 * discovery against `serverUrl` to learn the authorization server, then RFC
 * 8414 / OIDC discovery for its endpoints. The API path (Phase 3) passes
 * `authorizationServer` directly and skips PRM.
 */
export interface McpDiscovery {
  serverUrl: string;
  protectedResourceMetadataPath?: string;
  /** Pinned AS from the binding; overrides PRM-discovered authorization servers. */
  authorizationServer?: string;
}

/**
 * The owner + client + resource selectors that pin one logical token row.
 * Resolved by the caller via `resolveOAuthOwner` (identity) and the binding's
 * declared `clientScope` (client); never inferred with a fallback here.
 */
export interface OAuthBindingTarget {
  integrationKind: IntegrationKind;
  /** serverId (MCP) | apiId (API) — the logical provider, NOT the binding. */
  resourceKey: string;
  bindingId: string;
  ownerScope: OAuthOwnerScope;
  /** Pinned owner id (userId | spaceId | tenantId), already resolved. */
  ownerId: string;
  clientScope: OAuthClientScope;
  /** Per-issuer disambiguator for tenant/space `oauth_clients` lookups. */
  issuerKey: string;
  /**
   * Platform-client identity for `clientScope='platform'` (the MCP CIMD
   * metadata URL). Ignored for tenant/space client scopes.
   */
  platformClientId?: string;
  /**
   * Binding-pinned authorization server (RFC 8414 issuer). The API path
   * supplies this directly — it carries no MCP PRM discovery descriptor, so
   * the AS endpoints are discovered from this issuer. Takes precedence over a
   * tenant/space client's registered `authorizationServer`. Ignored when an
   * MCP `discovery` descriptor is present (PRM/binding pins the AS there).
   */
  authorizationServer?: string;
}

// ============================================================================
// PKCE helpers
// ============================================================================

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** Generate a PKCE verifier + S256 challenge per RFC 7636. */
export function generatePkce(): PkcePair {
  // RFC 7636 §4.1: verifier is 43-128 chars [A-Z a-z 0-9 -._~]. base64url of
  // 32 random bytes is 43 chars and within the allowed alphabet.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Generate an opaque state token of the form `{tenantBase64}.{randomBase64}`.
 * The callback (which is not tenant-authenticated — runs in the user's
 * browser session) parses the prefix to know which tenant schema to query
 * for the `oauth_state` row. The random suffix (256 bits of entropy) is
 * the actual CSRF / replay guard; the tenant prefix is purely a routing hint
 * and is not a secret (tenantIds are not secrets in this system).
 */
export function generateStateToken(tenantId: string): string {
  const tenantPart = Buffer.from(tenantId, 'utf-8').toString('base64url');
  const randomPart = randomBytes(32).toString('base64url');
  return `${tenantPart}.${randomPart}`;
}

/**
 * Parse `state` produced by `generateStateToken`. Returns `null` on malformed
 * input so the callback can fail closed with a clear error.
 */
export function parseStateToken(state: string): { tenantId: string; randomPart: string } | null {
  const dotIdx = state.indexOf('.');
  if (dotIdx <= 0 || dotIdx === state.length - 1) return null;
  const tenantPart = state.slice(0, dotIdx);
  const randomPart = state.slice(dotIdx + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(tenantPart) || !/^[A-Za-z0-9_-]+$/.test(randomPart)) return null;
  let tenantId: string;
  try {
    tenantId = Buffer.from(tenantPart, 'base64url').toString('utf-8');
  } catch {
    return null;
  }
  if (tenantId.length === 0) return null;
  return { tenantId, randomPart };
}

// ============================================================================
// Discovery helpers (MCP-gated PRM; API passes the AS directly)
// ============================================================================

interface ResolvedAs {
  asMetadata: AsMetadata;
  prm?: PrmDiscoveryResult;
}

async function resolveAuthorizationServer(
  discovery: McpDiscovery | undefined,
  bindingAuthorizationServer: string | undefined,
  clientAuthorizationServer: string | undefined,
  issuerKey: string | undefined,
  bindingId: string,
  fetchImpl?: typeof fetch,
): Promise<ResolvedAs> {
  if (discovery) {
    const prm = await discoverPRM(discovery.serverUrl, {
      ...(discovery.protectedResourceMetadataPath
        ? { protectedResourceMetadataPath: discovery.protectedResourceMetadataPath }
        : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    const issuer =
      discovery.authorizationServer ??
      clientAuthorizationServer ??
      prm.prm.authorization_servers?.[0];
    if (!issuer) {
      throw new Error(
        `oauth_no_authorization_server: PRM at ${prm.metadataUrl} returned no authorization_servers and no authorizationServer is set for binding "${bindingId}".`,
      );
    }
    const asMetadata = await discoverAsMetadata(issuer, fetchImpl ? { fetchImpl } : {});
    return { asMetadata, prm };
  }

  // No PRM descriptor (the API path). A curated O4 issuer pins the method:
  // providers without an RFC 8414 / OIDC discovery document (e.g. GitHub) carry
  // explicit endpoints, so build the metadata directly; others carry a discovery
  // URL. An operator-pinned authorizationServer is the fallback for un-registered
  // (free-form) issuers.
  const issuerDef = issuerKey ? getOAuthIssuer(issuerKey) : undefined;
  if (issuerDef) {
    if ('authorizationServer' in issuerDef.endpoints) {
      return {
        asMetadata: {
          issuer: extractUrlOrigin(issuerDef.endpoints.authorizationServer),
          authorization_endpoint: issuerDef.endpoints.authorizationServer,
          token_endpoint: issuerDef.endpoints.tokenEndpoint,
          ...(issuerDef.defaultScopes.length > 0
            ? { scopes_supported: issuerDef.defaultScopes }
            : {}),
        },
      };
    }
    return {
      asMetadata: await discoverAsMetadata(
        extractUrlOrigin(issuerDef.endpoints.discoveryUrl),
        fetchImpl ? { fetchImpl } : {},
      ),
    };
  }

  const issuer = bindingAuthorizationServer ?? clientAuthorizationServer;
  if (!issuer) {
    throw new Error(
      `oauth_no_authorization_server: binding "${bindingId}" has no MCP discovery descriptor, no registered issuer "${issuerKey ?? '(none)'}", and no pinned authorizationServer.`,
    );
  }
  const asMetadata = await discoverAsMetadata(issuer, fetchImpl ? { fetchImpl } : {});
  return { asMetadata };
}

// ============================================================================
// Consent: start
// ============================================================================

export interface StartConsentParams {
  tenantId: string;
  spaceId: string;
  target: OAuthBindingTarget;
  /**
   * MCP PRM discovery descriptor. Omit for the API path, which must instead
   * carry the authorization server via the resolved client or `resource`.
   */
  discovery?: McpDiscovery;
  /** Requested scopes; falls back to the client's default scopes, then PRM. */
  scopes?: string[];
  /** RFC 8707 audience; defaults to the discovery origin when omitted. */
  resource?: string;
  /**
   * Platform callback URL (e.g. `https://api.aflow.ai/v1/oauth/callback`).
   *
   * MUST be the single platform-wide constant — derived server-side from
   * `API_BASE_URL`. The REST consent route is the single source of this
   * value; agent-callable consent input does NOT carry an override (would
   * be an open-redirect vector). The URL must exactly match the
   * `redirect_uris` listed in our hosted CIMD document.
   */
  redirectUri: string;
  /** Drizzle DB handle. */
  db: unknown;
  /** Default 10 minutes. */
  stateTtlMs?: number;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

export interface StartConsentResult {
  authorizationUrl: string;
  state: string;
  expiresAt: Date;
  /** Discovery-path metadata; present for the MCP path. Useful for audit + diagnostics. */
  prm?: PrmDiscoveryResult;
  asMetadata: AsMetadata;
}

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Start an OAuth 2.1 PKCE consent flow. Returns the authorization URL the
 * operator UI redirects the user to. Stores state in `oauth_state` keyed to
 * the pinned `(integration_kind, resource_key, owner_scope, owner_id)`.
 */
export async function startConsent(params: StartConsentParams): Promise<StartConsentResult> {
  const { target } = params;

  const client = await resolveOAuthClient({
    db: params.db,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    clientScope: target.clientScope,
    issuerKey: target.issuerKey,
    ...(target.platformClientId ? { platformClientId: target.platformClientId } : {}),
  });

  const { asMetadata, prm } = await resolveAuthorizationServer(
    params.discovery,
    target.authorizationServer,
    client.authorizationServer,
    target.issuerKey,
    target.bindingId,
    params.fetchImpl,
  );

  const { verifier, challenge } = generatePkce();
  // State carries tenantId in the prefix so the callback (which is not
  // tenant-authenticated) can route to the right schema. Random suffix is
  // the CSRF / replay guard.
  const state = generateStateToken(params.tenantId);
  const expiresAt = new Date(Date.now() + (params.stateTtlMs ?? DEFAULT_STATE_TTL_MS));

  const resource =
    params.resource ??
    (params.discovery ? extractUrlOrigin(params.discovery.serverUrl) : undefined);
  const scopes = params.scopes ?? client.defaultScopes ?? prm?.prm.scopes_supported ?? [];

  // Persist state row BEFORE returning the URL — if the row write fails, the
  // user never gets a URL they could redeem.
  const tenantCtx = createTenantContext(TenantIdSchema.parse(params.tenantId));
  await withTenantSchema(
    params.db as Parameters<typeof withTenantSchema>[0],
    tenantCtx,
    async (tx) => {
      await tx.insert(oauthStateTable).values({
        state,
        integrationKind: target.integrationKind,
        resourceKey: target.resourceKey,
        bindingId: target.bindingId,
        spaceId: params.spaceId,
        ownerScope: target.ownerScope,
        ownerId: target.ownerId,
        clientScope: target.clientScope,
        codeVerifier: verifier,
        redirectUri: params.redirectUri,
        ...(resource ? { resource } : {}),
        scopesJson: scopes,
        expiresAt,
      });
    },
  );

  const authUrl = new URL(asMetadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.clientId);
  authUrl.searchParams.set('redirect_uri', params.redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  if (scopes.length > 0) authUrl.searchParams.set('scope', scopes.join(' '));
  if (resource) authUrl.searchParams.set('resource', resource);

  const result: StartConsentResult = {
    authorizationUrl: authUrl.toString(),
    state,
    expiresAt,
    asMetadata,
  };
  if (prm) result.prm = prm;
  return result;
}

// ============================================================================
// Consent: complete (callback)
// ============================================================================

/**
 * Resolved consent context the callback supplies for a state row. The
 * `clientScope`/`ownerScope`/`ownerId` come from the persisted `oauth_state`
 * row, not the binding — the binding may have changed since consent started.
 */
export interface CompleteConsentContext {
  tenantId: string;
  /** MCP PRM discovery descriptor; omit for the API path. */
  discovery?: McpDiscovery;
  /**
   * Binding-pinned authorization server (API path, no PRM). Takes precedence
   * over a tenant/space client's registered AS; required for an API binding on
   * the platform client (which carries no AS).
   */
  authorizationServer?: string;
  /** Per-issuer disambiguator for tenant/space client lookup. */
  issuerKey: string;
  /** Platform client identity (MCP CIMD URL) for `clientScope='platform'`. */
  platformClientId?: string;
}

export interface CompleteConsentParams {
  state: string;
  code: string;
  db: unknown;
  /** Resolves the tenant + discovery + client selectors for a state row's binding. */
  resolveContext: (row: {
    bindingId: string;
    spaceId: string;
    resourceKey: string;
    integrationKind: IntegrationKind;
  }) => Promise<CompleteConsentContext>;
  fetchImpl?: typeof fetch;
}

export interface CompleteConsentResult {
  bindingId: string;
  spaceId: string;
  resourceKey: string;
  integrationKind: IntegrationKind;
  ownerScope: OAuthOwnerScope;
  ownerId: string;
  expiresAt: Date;
  scopes: string[];
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface PostToTokenEndpointParams {
  tokenEndpoint: string;
  body: URLSearchParams;
  clientId: string;
  clientSecret?: string;
  failureCode: string;
  missingTokenCode: string;
  fetchImpl?: typeof fetch;
}

/**
 * The single authority for POSTing to a token endpoint (code exchange and
 * refresh). The endpoint comes from AS discovery over a space-authored issuer,
 * so it is SSRF-checked and https-only before the secret-bearing request, and
 * redirects are refused (a redirected token POST re-sends credentials
 * elsewhere).
 */
export async function postToTokenEndpoint(
  params: PostToTokenEndpointParams,
): Promise<TokenResponse> {
  const validated = await validateCredentialedUrl(params.tokenEndpoint);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  // RFC 6749 §6 — confidential clients authenticate to the token endpoint the
  // same way on exchange and refresh. CIMD/public clients carry no secret.
  if (params.clientSecret) {
    headers['Authorization'] =
      'Basic ' + Buffer.from(`${params.clientId}:${params.clientSecret}`).toString('base64');
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(validated.url.toString(), {
    method: 'POST',
    headers,
    body: params.body.toString(),
    redirect: 'error',
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${params.failureCode}: ${String(response.status)} ${text.slice(0, 256)}`);
  }
  const token = (await response.json()) as TokenResponse;
  if (!token.access_token) throw new Error(params.missingTokenCode);
  return token;
}

/**
 * Finalize the OAuth flow: validate state, exchange code, persist tokens.
 *
 * Idempotency: the state row is deleted after a successful exchange. A
 * replayed callback with the same state returns `state_not_found`. The token
 * endpoint itself enforces single-use of `code`; if the AS allows replay,
 * the second call still writes the same row (UPSERT) and is observationally
 * idempotent.
 */
export async function completeConsent(
  params: CompleteConsentParams,
): Promise<CompleteConsentResult> {
  // State carries tenantId in its prefix so we can route to the right tenant
  // schema without auth context (callback runs in the user's browser).
  const parsed = parseStateToken(params.state);
  if (!parsed) throw new Error('oauth_callback_state_malformed');
  const stateRow = await loadStateRow(params.state, parsed.tenantId, params.db);
  if (!stateRow) {
    throw new Error('oauth_callback_state_not_found');
  }
  if (stateRow.expiresAt.getTime() < Date.now()) {
    throw new Error('oauth_callback_state_expired');
  }

  const ctx = await params.resolveContext({
    bindingId: stateRow.bindingId,
    spaceId: stateRow.spaceId,
    resourceKey: stateRow.resourceKey,
    integrationKind: stateRow.integrationKind,
  });

  const client = await resolveOAuthClient({
    db: params.db,
    tenantId: ctx.tenantId,
    spaceId: stateRow.spaceId,
    clientScope: stateRow.clientScope,
    issuerKey: ctx.issuerKey,
    ...(ctx.platformClientId ? { platformClientId: ctx.platformClientId } : {}),
  });

  const { asMetadata } = await resolveAuthorizationServer(
    ctx.discovery,
    ctx.authorizationServer,
    client.authorizationServer,
    ctx.issuerKey,
    stateRow.bindingId,
    params.fetchImpl,
  );

  // Token exchange (RFC 6749 §4.1.3 with RFC 7636 verifier + RFC 8707 resource).
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', params.code);
  body.set('redirect_uri', stateRow.redirectUri);
  body.set('code_verifier', stateRow.codeVerifier);
  body.set('client_id', client.clientId);
  if (stateRow.resource) body.set('resource', stateRow.resource);

  const token = await postToTokenEndpoint({
    tokenEndpoint: asMetadata.token_endpoint,
    body,
    clientId: client.clientId,
    ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
    failureCode: 'oauth_token_exchange_failed',
    missingTokenCode: 'oauth_token_response_missing_access_token',
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });

  const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  const grantedScopes = token.scope
    ? token.scope.split(/\s+/).filter(Boolean)
    : stateRow.scopesJson;

  const accessTokenEnc = await encryptCredentialEnvelope(token.access_token);
  const refreshTokenEnc = token.refresh_token
    ? await encryptCredentialEnvelope(token.refresh_token)
    : null;

  const tenantCtx = createTenantContext(TenantIdSchema.parse(ctx.tenantId));
  await withTenantSchema(
    params.db as Parameters<typeof withTenantSchema>[0],
    tenantCtx,
    async (tx) => {
      // Upsert token row keyed by (integration_kind, resource_key, owner_scope, owner_id).
      await tx.execute(sql`
        INSERT INTO oauth_tokens (
          integration_kind, resource_key, owner_scope, owner_id,
          access_token_enc, refresh_token_enc, token_type,
          scopes_json, audience, client_id_used, expires_at, obtained_at, updated_at
        )
        VALUES (
          ${stateRow.integrationKind},
          ${stateRow.resourceKey},
          ${stateRow.ownerScope},
          ${stateRow.ownerId},
          ${accessTokenEnc},
          ${refreshTokenEnc},
          ${token.token_type ?? 'Bearer'},
          ${JSON.stringify(grantedScopes)}::jsonb,
          ${stateRow.resource ?? null},
          ${client.clientId},
          ${expiresAt.toISOString()}::timestamptz,
          NOW(),
          NOW()
        )
        ON CONFLICT (integration_kind, resource_key, owner_scope, owner_id) DO UPDATE SET
          access_token_enc = EXCLUDED.access_token_enc,
          refresh_token_enc = EXCLUDED.refresh_token_enc,
          token_type = EXCLUDED.token_type,
          scopes_json = EXCLUDED.scopes_json,
          audience = EXCLUDED.audience,
          client_id_used = EXCLUDED.client_id_used,
          expires_at = EXCLUDED.expires_at,
          obtained_at = EXCLUDED.obtained_at,
          updated_at = NOW()
      `);
      // Single-use: delete the state row.
      await tx.delete(oauthStateTable).where(eq(oauthStateTable.state, params.state));
    },
  );

  return {
    bindingId: stateRow.bindingId,
    spaceId: stateRow.spaceId,
    resourceKey: stateRow.resourceKey,
    integrationKind: stateRow.integrationKind,
    ownerScope: stateRow.ownerScope,
    ownerId: stateRow.ownerId,
    expiresAt,
    scopes: grantedScopes,
  };
}

interface StateRow {
  state: string;
  integrationKind: IntegrationKind;
  resourceKey: string;
  bindingId: string;
  spaceId: string;
  ownerScope: OAuthOwnerScope;
  ownerId: string;
  clientScope: OAuthClientScope;
  codeVerifier: string;
  redirectUri: string;
  resource: string | null;
  scopesJson: string[];
  expiresAt: Date;
}

async function loadStateRow(
  state: string,
  tenantId: string,
  db: unknown,
): Promise<StateRow | null> {
  const tenantCtx = createTenantContext(TenantIdSchema.parse(tenantId));
  const rows = await withTenantSchema(
    db as Parameters<typeof withTenantSchema>[0],
    tenantCtx,
    async (tx) => {
      return tx
        .select({
          state: oauthStateTable.state,
          integrationKind: oauthStateTable.integrationKind,
          resourceKey: oauthStateTable.resourceKey,
          bindingId: oauthStateTable.bindingId,
          spaceId: oauthStateTable.spaceId,
          ownerScope: oauthStateTable.ownerScope,
          ownerId: oauthStateTable.ownerId,
          clientScope: oauthStateTable.clientScope,
          codeVerifier: oauthStateTable.codeVerifier,
          redirectUri: oauthStateTable.redirectUri,
          resource: oauthStateTable.resource,
          scopesJson: oauthStateTable.scopesJson,
          expiresAt: oauthStateTable.expiresAt,
        })
        .from(oauthStateTable)
        .where(eq(oauthStateTable.state, state))
        .limit(1);
    },
  );
  const row = (rows as Array<Record<string, unknown>> | undefined)?.[0];
  if (!row) return null;
  return {
    state: row['state'] as string,
    integrationKind: row['integrationKind'] as IntegrationKind,
    resourceKey: row['resourceKey'] as string,
    bindingId: row['bindingId'] as string,
    spaceId: row['spaceId'] as string,
    ownerScope: row['ownerScope'] as OAuthOwnerScope,
    ownerId: row['ownerId'] as string,
    clientScope: row['clientScope'] as OAuthClientScope,
    codeVerifier: row['codeVerifier'] as string,
    redirectUri: row['redirectUri'] as string,
    resource: (row['resource'] as string | null) ?? null,
    scopesJson: row['scopesJson'] as string[],
    expiresAt: row['expiresAt'] as Date,
  };
}

// ============================================================================
// Access token retrieval / refresh
// ============================================================================

export interface GetValidAccessTokenParams {
  tenantId: string;
  spaceId: string;
  target: OAuthBindingTarget;
  /** MCP PRM discovery descriptor; omit for the API path. */
  discovery?: McpDiscovery;
  db: unknown;
  fetchImpl?: typeof fetch;
  /**
   * Reactive 401 path — skip the proactive-refresh check and unconditionally
   * call the refresh endpoint. Throws if no refresh_token is available
   * (operator must re-consent). Callers set this after observing a 401 on a
   * tool call to force token rotation before retrying.
   */
  forceRefresh?: boolean;
}

export interface GetValidAccessTokenResult {
  accessToken: string;
  tokenType: string;
  expiresAt: Date;
  refreshed: boolean;
}

/**
 * Minimum proactive refresh window in milliseconds — 30 seconds.
 *
 * Some ASes issue short-lived tokens (e.g., 60s for high-risk scopes); a
 * pure-percentage window (20% of 60s = 12s) is too tight given clock skew,
 * network latency to the token endpoint, and pool acquire time. Take the
 * larger of `0.2 * ttl` and this floor.
 */
const REFRESH_WINDOW_MIN_MS = 30 * 1000;

/**
 * Re-throw refresh failures when fewer than this many ms remain on the
 * current token. Below this threshold, falling through with a near-expired
 * token would force the caller to discover failure via a 401 mid-request;
 * the cleaner signal is to fail consent immediately so the operator sees
 * "re-consent required" rather than a tool failure.
 */
const REFRESH_FAILURE_HARD_FLOOR_MS = 60 * 1000;

/**
 * Returns a valid access token for the binding's pinned owner. Refreshes
 * proactively when within the last `max(20% of TTL, 30s)` of TTL (and a
 * refresh token is available). Throws `oauth_no_token` when no token row
 * exists (operator hasn't consented), when refresh fails near expiry, or when
 * a near-expired token has no refresh token to use.
 */
export async function getValidAccessToken(
  params: GetValidAccessTokenParams,
): Promise<GetValidAccessTokenResult> {
  const { target } = params;
  const row = await loadTokenRow(params);
  if (!row) {
    throw new Error(
      `oauth_no_token: binding "${target.bindingId}" has no OAuth token for ownerScope="${target.ownerScope}" ownerId="${target.ownerId}". Run consent first.`,
    );
  }

  // Reactive 401 retry path: skip proactive checks, refresh immediately.
  if (params.forceRefresh) {
    if (!row.refreshTokenEnc) {
      throw new Error(
        `oauth_force_refresh_no_refresh_token: binding "${target.bindingId}" ownerScope="${target.ownerScope}" ownerId="${target.ownerId}" has no refresh_token to use after a 401 — operator must re-consent.`,
      );
    }
    const refreshed = await refreshAccessToken({ ...params, currentRow: row });
    return { ...refreshed, refreshed: true };
  }

  const ttlMs = row.expiresAt.getTime() - row.obtainedAt.getTime();
  const remainingMs = row.expiresAt.getTime() - Date.now();
  const refreshWindowMs = Math.max(ttlMs * 0.2, REFRESH_WINDOW_MIN_MS);
  const shouldRefresh = remainingMs < refreshWindowMs;

  if (shouldRefresh && row.refreshTokenEnc) {
    try {
      const refreshed = await refreshAccessToken({ ...params, currentRow: row });
      return { ...refreshed, refreshed: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Hard failure when we're already past safe operating margin —
      // returning a near-expired token would force a 401 mid-call and a
      // user-visible failure. Re-throw so the operator re-consents now.
      if (remainingMs <= REFRESH_FAILURE_HARD_FLOOR_MS) {
        console.warn(
          `[oauth] proactive refresh failed near expiry for binding="${target.bindingId}" ownerId="${target.ownerId}" remaining=${String(remainingMs)}ms — re-throwing: ${errMsg}`,
        );
        throw err;
      }
      // Far from expiry: log and fall through with the current token. The
      // reactive 401 path in the executor will retry refresh when needed.

      console.warn(
        `[oauth] proactive refresh failed for binding="${target.bindingId}" — falling through with current token (remaining=${String(remainingMs)}ms): ${errMsg}`,
      );
    }
  } else if (shouldRefresh && !row.refreshTokenEnc) {
    // Refresh due but no refresh token to use — token is heading toward
    // expiry without a way to extend it. Operators should see this.

    console.warn(
      `[oauth] binding="${target.bindingId}" ownerId="${target.ownerId}" needs re-consent — no refresh_token and ${String(remainingMs)}ms until expiry.`,
    );
  }

  const accessToken = await decryptCredentialAsync(row.accessTokenEnc);
  return {
    accessToken,
    tokenType: row.tokenType,
    expiresAt: row.expiresAt,
    refreshed: false,
  };
}

interface TokenRow {
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenType: string;
  scopesJson: string[];
  audience: string | null;
  expiresAt: Date;
  obtainedAt: Date;
}

async function loadTokenRow(params: GetValidAccessTokenParams): Promise<TokenRow | null> {
  const { target } = params;
  const tenantCtx = createTenantContext(TenantIdSchema.parse(params.tenantId));
  const rows = await withTenantSchema(
    params.db as Parameters<typeof withTenantSchema>[0],
    tenantCtx,
    async (tx) => {
      return tx
        .select({
          accessTokenEnc: oauthTokensTable.accessTokenEnc,
          refreshTokenEnc: oauthTokensTable.refreshTokenEnc,
          tokenType: oauthTokensTable.tokenType,
          scopesJson: oauthTokensTable.scopesJson,
          audience: oauthTokensTable.audience,
          expiresAt: oauthTokensTable.expiresAt,
          obtainedAt: oauthTokensTable.obtainedAt,
        })
        .from(oauthTokensTable)
        .where(
          and(
            eq(oauthTokensTable.integrationKind, target.integrationKind),
            eq(oauthTokensTable.resourceKey, target.resourceKey),
            eq(oauthTokensTable.ownerScope, target.ownerScope),
            eq(oauthTokensTable.ownerId, target.ownerId),
          ),
        )
        .limit(1);
    },
  );
  const row = (rows as Array<Record<string, unknown>> | undefined)?.[0];
  if (!row) return null;
  return {
    accessTokenEnc: row['accessTokenEnc'] as string,
    refreshTokenEnc: (row['refreshTokenEnc'] as string | null) ?? null,
    tokenType: row['tokenType'] as string,
    scopesJson: row['scopesJson'] as string[],
    audience: (row['audience'] as string | null) ?? null,
    expiresAt: row['expiresAt'] as Date,
    obtainedAt: row['obtainedAt'] as Date,
  };
}

interface RefreshParams extends GetValidAccessTokenParams {
  currentRow: TokenRow;
}

async function refreshAccessToken(
  params: RefreshParams,
): Promise<Omit<GetValidAccessTokenResult, 'refreshed'>> {
  const { target, currentRow } = params;

  const client = await resolveOAuthClient({
    db: params.db,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    clientScope: target.clientScope,
    issuerKey: target.issuerKey,
    ...(target.platformClientId ? { platformClientId: target.platformClientId } : {}),
  });

  const { asMetadata } = await resolveAuthorizationServer(
    params.discovery,
    target.authorizationServer,
    client.authorizationServer,
    target.issuerKey,
    target.bindingId,
    params.fetchImpl,
  );

  if (!currentRow.refreshTokenEnc) throw new Error('oauth_refresh_no_refresh_token');
  const refreshToken = await decryptCredentialAsync(currentRow.refreshTokenEnc);

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);
  body.set('client_id', client.clientId);
  if (currentRow.audience) body.set('resource', currentRow.audience);

  const token = await postToTokenEndpoint({
    tokenEndpoint: asMetadata.token_endpoint,
    body,
    clientId: client.clientId,
    ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
    failureCode: 'oauth_refresh_failed',
    missingTokenCode: 'oauth_refresh_missing_access_token',
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });

  const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 3600;
  const newExpiresAt = new Date(Date.now() + expiresIn * 1000);
  const newAccessEnc = await encryptCredentialEnvelope(token.access_token);
  // ASes may rotate refresh tokens or return only access_token on refresh.
  // Preserve the old refresh token when no new one is returned.
  const newRefreshEnc = token.refresh_token
    ? await encryptCredentialEnvelope(token.refresh_token)
    : currentRow.refreshTokenEnc;

  const tenantCtx = createTenantContext(TenantIdSchema.parse(params.tenantId));
  await withTenantSchema(
    params.db as Parameters<typeof withTenantSchema>[0],
    tenantCtx,
    async (tx) => {
      await tx.execute(sql`
        UPDATE oauth_tokens
        SET access_token_enc = ${newAccessEnc},
            refresh_token_enc = ${newRefreshEnc},
            client_id_used = ${client.clientId},
            expires_at = ${newExpiresAt.toISOString()}::timestamptz,
            obtained_at = NOW(),
            updated_at = NOW()
        WHERE integration_kind = ${target.integrationKind}
          AND resource_key = ${target.resourceKey}
          AND owner_scope = ${target.ownerScope}
          AND owner_id = ${target.ownerId}
      `);
    },
  );

  return {
    accessToken: token.access_token,
    tokenType: token.token_type ?? currentRow.tokenType,
    expiresAt: newExpiresAt,
  };
}

// ============================================================================
// State reaper (called at executor boot)
// ============================================================================

/**
 * Delete expired `oauth_state` rows in a single tenant. Called at executor
 * startup (per-tenant) and on a periodic timer. Returns the count deleted via
 * `DELETE ... RETURNING` (driver-agnostic — `rowCount` on `tx.execute` is
 * unreliable across drivers).
 *
 * Per-tenant by design: the caller iterates `listTenantSchemas` or similar
 * to reap across all tenants.
 */
export async function reapExpiredOauthState(tenantId: string, db: unknown): Promise<number> {
  const tenantCtx = createTenantContext(TenantIdSchema.parse(tenantId));
  return withTenantSchema(db as Parameters<typeof withTenantSchema>[0], tenantCtx, async (tx) => {
    const result = await tx.execute<{ state: string }>(
      sql`DELETE FROM oauth_state WHERE expires_at < NOW() RETURNING state`,
    );
    // Drizzle's tx.execute returns either an array of rows or a result
    // object with a `rows` property depending on driver. Normalize.
    if (Array.isArray(result)) return result.length;
    const rows = (result as { rows?: unknown[] } | undefined)?.rows;
    return Array.isArray(rows) ? rows.length : 0;
  });
}
