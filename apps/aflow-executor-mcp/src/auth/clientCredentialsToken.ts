import { decryptCredentialAsync } from '@aflow/database';
import { validateCredentialedUrl } from '@aflow/network-safety';
import { assertTenantPolicyPermitsTokenEndpoint } from '../handlers/tenantPolicyGuard.js';

const CACHE_PREFIX = 'aflow:mcp:oauth2:cc:';

export interface ClientCredentialsRedisLike {
  get: (k: string) => Promise<string | null>;
  set: (k: string, v: string, mode: string, ttl: number) => Promise<unknown>;
  del: (k: string) => Promise<unknown>;
}

export interface ClientCredentialsAuth {
  tokenEndpoint: string;
  clientIdCredentialKey: string;
  clientSecretCredentialKey: string;
  scopes?: string[] | undefined;
}

export interface ClientCredentialsParams {
  tenantId: string;
  spaceId: string;
  bindingId: string;
  auth: ClientCredentialsAuth;
  credentialStore: Map<string, string>;
  redis?: ClientCredentialsRedisLike;
  fetchImpl?: typeof fetch;
  /** Reactive 401 path: bypass cache and fetch a fresh token. */
  forceRefresh?: boolean;
  /**
   * Allowlist-mode permitted hosts for this binding (tenant allowlist ∪
   * catalog grant). Null/absent when the tenant policy is open.
   */
  tenantPermittedHosts?: readonly string[] | null;
}

export interface ClientCredentialsResult {
  accessToken: string;
  /** True when we fetched a new token (caller must evict pool entry). */
  refreshed: boolean;
}

export async function getClientCredentialsToken(
  params: ClientCredentialsParams,
): Promise<ClientCredentialsResult> {
  assertTenantPolicyPermitsTokenEndpoint(params.tenantPermittedHosts, params.auth.tokenEndpoint);

  const cacheKey = cacheKeyFor(params);

  if (params.redis && !params.forceRefresh) {
    try {
      const cached = await params.redis.get(cacheKey);
      if (cached) return { accessToken: cached, refreshed: false };
    } catch {
      // best-effort — fall through to fetch
    }
  }

  if (params.forceRefresh && params.redis) {
    try {
      await params.redis.del(cacheKey);
    } catch {
      /* best-effort */
    }
  }

  // The endpoint is space-authored and the exchange POSTs the client secret
  // to it: validate before any secret is even resolved.
  const validated = await validateCredentialedUrl(params.auth.tokenEndpoint);

  const clientId = await resolveCredential(
    params.credentialStore,
    params.bindingId,
    params.auth.clientIdCredentialKey,
  );
  const clientSecret = await resolveCredential(
    params.credentialStore,
    params.bindingId,
    params.auth.clientSecretCredentialKey,
  );

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (params.auth.scopes && params.auth.scopes.length > 0) {
    body.set('scope', params.auth.scopes.join(' '));
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(validated.url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      redirect: 'error',
    });
  } catch (err) {
    throw new Error(
      `oauth_client_credentials_unreachable: binding "${params.bindingId}" token endpoint ${params.auth.tokenEndpoint} unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `oauth_client_credentials_failed: binding "${params.bindingId}" token endpoint returned ${String(response.status)} — ${text.slice(0, 256)}`,
    );
  }

  const tokenResponse = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  const accessToken = tokenResponse.access_token;
  if (!accessToken) {
    throw new Error(
      `oauth_client_credentials_missing_access_token: binding "${params.bindingId}" token response did not include access_token`,
    );
  }

  if (params.redis) {
    const expiresIn = tokenResponse.expires_in ?? 3600;
    // Cache for 60s less than the AS-reported TTL to leave headroom; floor at
    // 30s so a misconfigured AS reporting `expires_in: 60` still gets cached.
    const ttlSeconds = Math.max(30, expiresIn - 60);
    try {
      await params.redis.set(cacheKey, accessToken, 'EX', ttlSeconds);
    } catch {
      // best-effort — uncached token still works for this call
    }
  }

  return { accessToken, refreshed: true };
}

async function resolveCredential(
  credentialStore: Map<string, string>,
  bindingId: string,
  credentialKey: string,
): Promise<string> {
  const encrypted = credentialStore.get(credentialKey);
  if (!encrypted) {
    throw new Error(
      `oauth_client_credentials_missing_credential: binding "${bindingId}" credential "${credentialKey}" not found in api_credentials`,
    );
  }
  try {
    return await decryptCredentialAsync(encrypted);
  } catch {
    throw new Error(
      `oauth_client_credentials_decrypt_failed: binding "${bindingId}" credential "${credentialKey}" failed to decrypt — encryption key may have changed`,
    );
  }
}

function cacheKeyFor(params: ClientCredentialsParams): string {
  return `${CACHE_PREFIX}${params.tenantId}:${params.bindingId}:${params.spaceId}`;
}
