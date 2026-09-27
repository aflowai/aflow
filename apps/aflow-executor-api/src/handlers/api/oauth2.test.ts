/**
 * SSRF guard on the OAuth2 client-credentials token exchange.
 *
 * The token endpoint is space-authored and the exchange POSTs the client
 * secret to it, so it must pass the same network-safety checks as request
 * execution: https only, no private/reserved IPs, no redirects. Every case
 * here is DNS-free (protocol checks fire before resolution; IP literals skip
 * lookup) so the suite stays deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { SsrfBlockedError } from '@aflow/network-safety';
import { resolveOAuth2Token } from './oauth2.js';
import { ApiExecutionError, type TenantHostGuard } from './types.js';

vi.mock('./credentials.js', () => ({
  resolveCredentialOrThrow: vi.fn(
    (store: ReadonlyMap<string, string>, _apiId: string, key: string) =>
      Promise.resolve(store.get(key) ?? ''),
  ),
}));

const ctx = {
  job: { tenantId: 'tenant-1' },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
} as unknown as ExecutorContext;

const credentialStore = new Map([
  ['client_id_key', 'client-id'],
  ['client_secret_key', 'client-secret'],
]);

function resolveWithEndpoint(tokenEndpoint: string, tenantHostGuard?: TenantHostGuard) {
  return resolveOAuth2Token(
    credentialStore,
    undefined,
    ctx,
    'api-1',
    {
      tokenEndpoint,
      clientIdCredentialKey: 'client_id_key',
      clientSecretCredentialKey: 'client_secret_key',
    },
    tenantHostGuard,
  );
}

describe('resolveOAuth2Token SSRF guard', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects an http token endpoint before any network activity', async () => {
    await expect(resolveWithEndpoint('http://auth.example.com/token')).rejects.toThrow(
      SsrfBlockedError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed token endpoint', async () => {
    await expect(resolveWithEndpoint('not-a-url')).rejects.toThrow(SsrfBlockedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a private-IP token endpoint (loopback)', async () => {
    await expect(resolveWithEndpoint('https://127.0.0.1/token')).rejects.toThrow(SsrfBlockedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects the cloud metadata endpoint', async () => {
    await expect(resolveWithEndpoint('https://169.254.169.254/token')).rejects.toThrow(
      SsrfBlockedError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches a validated public https endpoint with redirects refused', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }),
    );

    const token = await resolveWithEndpoint('https://8.8.8.8/token');

    expect(token).toBe('tok');
    expect(fetch).toHaveBeenCalledWith(
      'https://8.8.8.8/token',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
  });
});

describe('resolveOAuth2Token tenant host guard', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocks a token endpoint host outside the tenant guard before any network activity', async () => {
    let err: unknown;
    try {
      await resolveWithEndpoint('https://8.8.8.8/token', {
        permittedHosts: ['api.allowed.example'],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiExecutionError);
    const aflowError = (err as ApiExecutionError).aflowError;
    expect(aflowError.code).toBe('API_BINDING_EGRESS_BLOCKED');
    expect(aflowError.details).toMatchObject({
      blockedHost: '8.8.8.8',
      blockKind: 'tenant_policy_blocked',
      apiId: 'api-1',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exchanges when the guard covers the token endpoint host', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }),
    );
    const token = await resolveWithEndpoint('https://8.8.8.8/token', {
      permittedHosts: ['8.8.8.8'],
    });
    expect(token).toBe('tok');
  });

  it('exchanges without a guard (open mode)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }),
    );
    const token = await resolveWithEndpoint('https://8.8.8.8/token');
    expect(token).toBe('tok');
  });
});
