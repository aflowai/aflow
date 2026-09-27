/**
 * OAuth2 client credentials token resolution.
 */
import { apiError } from '../../lib/api-errors.js';
import { validateCredentialedUrl } from '@aflow/network-safety';
import { ApiExecutionError, type TenantHostGuard } from './types.js';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { resolveCredentialOrThrow } from './credentials.js';
import { assertTenantPolicyPermitsHost } from './errors.js';

export const OAUTH2_CACHE_PREFIX = 'aflow:oauth2:token:';

interface RedisLike {
  get: (k: string) => Promise<string | null>;
  set: (k: string, v: string, mode: string, ttl: number) => Promise<unknown>;
}

export async function resolveOAuth2Token(
  credentialStore: ReadonlyMap<string, string>,
  redis: RedisLike | undefined,
  ctx: ExecutorContext,
  apiId: string,
  auth: {
    tokenEndpoint: string;
    clientIdCredentialKey: string;
    clientSecretCredentialKey: string;
    scopes?: string[] | undefined;
  },
  tenantHostGuard?: TenantHostGuard,
): Promise<string> {
  // The exchange contacts a space-authored endpoint with the client secret —
  // judged by the same tenant guard as the call itself, before even a cached
  // token is honored. Unparseable endpoints fall through to
  // validateCredentialedUrl's rejection below.
  if (tenantHostGuard !== undefined) {
    let tokenHost: string | null = null;
    try {
      tokenHost = new URL(auth.tokenEndpoint).hostname;
    } catch {
      tokenHost = null;
    }
    if (tokenHost !== null) {
      assertTenantPolicyPermitsHost(tenantHostGuard, tokenHost, { apiId });
    }
  }

  const cacheKey = `${OAUTH2_CACHE_PREFIX}${ctx.job.tenantId}:${apiId}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        ctx.log.info('OAuth2 token resolved from cache', { apiId });
        return cached;
      }
    } catch {
      ctx.log.warn('Failed to read OAuth2 token from cache, will fetch fresh', { apiId });
    }
  }

  // The endpoint is space-authored and the exchange POSTs the client secret
  // to it: validate before any secret is even resolved.
  const validated = await validateCredentialedUrl(auth.tokenEndpoint);

  const clientId = await resolveCredentialOrThrow(
    credentialStore,
    apiId,
    auth.clientIdCredentialKey,
  );
  const clientSecret = await resolveCredentialOrThrow(
    credentialStore,
    apiId,
    auth.clientSecretCredentialKey,
  );

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (auth.scopes && auth.scopes.length > 0) {
    body.set('scope', auth.scopes.join(' '));
  }

  ctx.log.info('Requesting OAuth2 access token', {
    apiId,
    tokenEndpoint: auth.tokenEndpoint,
  });

  let response: Response;
  try {
    response = await fetch(validated.url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'error',
    });
  } catch (err) {
    throw new ApiExecutionError(
      apiError(
        'API_AUTH_FAILED',
        `Failed to reach OAuth2 token endpoint for API "${apiId}": ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true, details: { apiId, tokenEndpoint: auth.tokenEndpoint } },
      ),
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiExecutionError(
      apiError(
        'API_AUTH_FAILED',
        `OAuth2 token exchange failed for API "${apiId}" (${String(response.status)}): ${text.slice(0, 200)}`,
        {
          retryable: response.status >= 500,
          details: { apiId, statusCode: response.status },
        },
      ),
    );
  }

  const tokenResponse = (await response.json()) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  };

  const accessToken = tokenResponse.access_token;
  if (!accessToken) {
    throw new ApiExecutionError(
      apiError('API_AUTH_FAILED', `OAuth2 response missing access_token for API "${apiId}"`, {
        retryable: false,
        details: { apiId },
      }),
    );
  }

  if (redis) {
    const expiresIn = tokenResponse.expires_in ?? 3600;
    const ttlSeconds = Math.max(30, expiresIn - 60);
    try {
      await redis.set(cacheKey, accessToken, 'EX', ttlSeconds);
      ctx.log.info('OAuth2 token cached', { apiId, ttlSeconds });
    } catch {
      ctx.log.warn('Failed to cache OAuth2 token', { apiId });
    }
  }

  return accessToken;
}
