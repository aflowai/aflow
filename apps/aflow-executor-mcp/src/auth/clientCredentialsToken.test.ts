import { describe, it, expect, beforeEach } from 'vitest';
import { encryptCredentialEnvelope } from '@aflow/database';
import {
  getClientCredentialsToken,
  type ClientCredentialsRedisLike,
} from './clientCredentialsToken.js';

interface FakeRedis extends ClientCredentialsRedisLike {
  store: Map<string, string>;
  sets: Array<{ key: string; value: string; ttl: number }>;
  dels: string[];
}

function makeFakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  const sets: Array<{ key: string; value: string; ttl: number }> = [];
  const dels: string[] = [];
  return {
    store,
    sets,
    dels,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v, _mode, ttl) => {
      store.set(k, v);
      sets.push({ key: k, value: v, ttl });
      return 'OK';
    },
    del: async (k) => {
      const had = store.delete(k);
      dels.push(k);
      return had ? 1 : 0;
    },
  };
}

function makeFetch(
  routes: Record<string, { status: number; body?: unknown }>,
  counter: { count: number },
): typeof fetch {
  return (async (input: unknown): Promise<Response> => {
    counter.count++;
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('getClientCredentialsToken', () => {
  let credentialStore: Map<string, string>;

  beforeEach(async () => {
    credentialStore = new Map();
    credentialStore.set('test-client-id', await encryptCredentialEnvelope('client-abc'));
    credentialStore.set('test-client-secret', await encryptCredentialEnvelope('secret-xyz'));
  });

  const baseAuth = {
    tokenEndpoint: 'https://8.8.8.8/oauth/token',
    clientIdCredentialKey: 'test-client-id',
    clientSecretCredentialKey: 'test-client-secret',
  };

  it('fetches a fresh token and caches it', async () => {
    const counter = { count: 0 };
    const fetchImpl = makeFetch(
      {
        'https://8.8.8.8/oauth/token': {
          status: 200,
          body: { access_token: 'tok-1', expires_in: 3600 },
        },
      },
      counter,
    );
    const redis = makeFakeRedis();

    const result = await getClientCredentialsToken({
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      bindingId: 'binding-1',
      auth: baseAuth,
      credentialStore,
      redis,
      fetchImpl,
    });

    expect(result.accessToken).toBe('tok-1');
    expect(result.refreshed).toBe(true);
    expect(counter.count).toBe(1);
    expect(redis.sets).toHaveLength(1);
    expect(redis.sets[0]?.value).toBe('tok-1');
    // 3600 - 60 = 3540 floor 30
    expect(redis.sets[0]?.ttl).toBe(3540);
  });

  it('returns cached token on second call without hitting the AS', async () => {
    const counter = { count: 0 };
    const fetchImpl = makeFetch(
      {
        'https://8.8.8.8/oauth/token': {
          status: 200,
          body: { access_token: 'tok-1', expires_in: 3600 },
        },
      },
      counter,
    );
    const redis = makeFakeRedis();

    await getClientCredentialsToken({
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      bindingId: 'binding-1',
      auth: baseAuth,
      credentialStore,
      redis,
      fetchImpl,
    });
    const second = await getClientCredentialsToken({
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      bindingId: 'binding-1',
      auth: baseAuth,
      credentialStore,
      redis,
      fetchImpl,
    });

    expect(counter.count).toBe(1); // only the first call hit the AS
    expect(second.accessToken).toBe('tok-1');
    expect(second.refreshed).toBe(false);
  });

  it('forceRefresh bypasses the cache and deletes the stale entry', async () => {
    const counter = { count: 0 };
    const fetchImpl = makeFetch(
      {
        'https://8.8.8.8/oauth/token': {
          status: 200,
          body: { access_token: 'tok-2', expires_in: 3600 },
        },
      },
      counter,
    );
    const redis = makeFakeRedis();
    // Seed the cache with a stale token.
    redis.store.set('aflow:mcp:oauth2:cc:tenant-1:binding-1:space-1', 'tok-stale');

    const result = await getClientCredentialsToken({
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      bindingId: 'binding-1',
      auth: baseAuth,
      credentialStore,
      redis,
      fetchImpl,
      forceRefresh: true,
    });

    expect(result.accessToken).toBe('tok-2');
    expect(result.refreshed).toBe(true);
    expect(counter.count).toBe(1);
    expect(redis.dels).toContain('aflow:mcp:oauth2:cc:tenant-1:binding-1:space-1');
  });

  it('per-space caching keeps tenant.binding tokens distinct by space', async () => {
    const counter = { count: 0 };
    const fetchImpl = makeFetch(
      {
        'https://8.8.8.8/oauth/token': {
          status: 200,
          body: { access_token: 'tok-shared', expires_in: 3600 },
        },
      },
      counter,
    );
    const redis = makeFakeRedis();

    await getClientCredentialsToken({
      tenantId: 'tenant-1',
      spaceId: 'space-A',
      bindingId: 'binding-1',
      auth: baseAuth,
      credentialStore,
      redis,
      fetchImpl,
    });
    await getClientCredentialsToken({
      tenantId: 'tenant-1',
      spaceId: 'space-B',
      bindingId: 'binding-1',
      auth: baseAuth,
      credentialStore,
      redis,
      fetchImpl,
    });

    // Different space → different cache key → second call still fetches.
    expect(counter.count).toBe(2);
    expect(redis.store.has('aflow:mcp:oauth2:cc:tenant-1:binding-1:space-A')).toBe(true);
    expect(redis.store.has('aflow:mcp:oauth2:cc:tenant-1:binding-1:space-B')).toBe(true);
  });

  it('throws when the AS returns non-2xx', async () => {
    const counter = { count: 0 };
    const fetchImpl = makeFetch(
      {
        'https://8.8.8.8/oauth/token': {
          status: 401,
          body: { error: 'invalid_client' },
        },
      },
      counter,
    );

    await expect(
      getClientCredentialsToken({
        tenantId: 'tenant-1',
        spaceId: 'space-1',
        bindingId: 'binding-1',
        auth: baseAuth,
        credentialStore,
        fetchImpl,
      }),
    ).rejects.toThrow(/oauth_client_credentials_failed/);
  });

  it('throws when access_token missing from response', async () => {
    const counter = { count: 0 };
    const fetchImpl = makeFetch(
      {
        'https://8.8.8.8/oauth/token': {
          status: 200,
          body: { token_type: 'Bearer', expires_in: 3600 }, // no access_token
        },
      },
      counter,
    );

    await expect(
      getClientCredentialsToken({
        tenantId: 'tenant-1',
        spaceId: 'space-1',
        bindingId: 'binding-1',
        auth: baseAuth,
        credentialStore,
        fetchImpl,
      }),
    ).rejects.toThrow(/oauth_client_credentials_missing_access_token/);
  });

  it('throws when a referenced credential is missing from the store', async () => {
    const counter = { count: 0 };
    const fetchImpl = makeFetch({}, counter);

    await expect(
      getClientCredentialsToken({
        tenantId: 'tenant-1',
        spaceId: 'space-1',
        bindingId: 'binding-1',
        auth: { ...baseAuth, clientIdCredentialKey: 'missing-key' },
        credentialStore,
        fetchImpl,
      }),
    ).rejects.toThrow(/oauth_client_credentials_missing_credential/);
    expect(counter.count).toBe(0); // never reaches the AS
  });

  it('includes scope on the token request when configured', async () => {
    const counter = { count: 0 };
    let capturedBody = '';
    const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      counter.count++;
      capturedBody = String(init?.body ?? '');
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === 'https://8.8.8.8/oauth/token') {
        return new Response(JSON.stringify({ access_token: 'tok-scoped', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    await getClientCredentialsToken({
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      bindingId: 'binding-1',
      auth: { ...baseAuth, scopes: ['read:tools', 'write:tools'] },
      credentialStore,
      fetchImpl,
    });

    expect(capturedBody).toContain('scope=read%3Atools+write%3Atools');
  });
});

describe('getClientCredentialsToken SSRF guard', () => {
  let credentialStore: Map<string, string>;

  beforeEach(async () => {
    credentialStore = new Map();
    credentialStore.set('test-client-id', await encryptCredentialEnvelope('client-abc'));
    credentialStore.set('test-client-secret', await encryptCredentialEnvelope('secret-xyz'));
  });

  function attempt(tokenEndpoint: string, counter: { count: number }) {
    return getClientCredentialsToken({
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      bindingId: 'binding-1',
      auth: {
        tokenEndpoint,
        clientIdCredentialKey: 'test-client-id',
        clientSecretCredentialKey: 'test-client-secret',
      },
      credentialStore,
      fetchImpl: makeFetch({}, counter),
    });
  }

  it('rejects an http token endpoint before any network activity', async () => {
    const counter = { count: 0 };
    await expect(attempt('http://8.8.8.8/oauth/token', counter)).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'invalid-protocol',
    });
    expect(counter.count).toBe(0);
  });

  it('rejects a loopback token endpoint', async () => {
    const counter = { count: 0 };
    await expect(attempt('https://127.0.0.1/oauth/token', counter)).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'private-ip',
    });
    expect(counter.count).toBe(0);
  });

  it('rejects the cloud metadata endpoint', async () => {
    const counter = { count: 0 };
    await expect(attempt('https://169.254.169.254/oauth/token', counter)).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'private-ip',
    });
    expect(counter.count).toBe(0);
  });

  it('refuses redirects on the token POST', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      calls.push(init);
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await getClientCredentialsToken({
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      bindingId: 'binding-1',
      auth: {
        tokenEndpoint: 'https://8.8.8.8/oauth/token',
        clientIdCredentialKey: 'test-client-id',
        clientSecretCredentialKey: 'test-client-secret',
      },
      credentialStore,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe('error');
  });
});

describe('getClientCredentialsToken tenant policy guard', () => {
  let credentialStore: Map<string, string>;

  beforeEach(async () => {
    credentialStore = new Map();
    credentialStore.set('test-client-id', await encryptCredentialEnvelope('client-abc'));
    credentialStore.set('test-client-secret', await encryptCredentialEnvelope('secret-xyz'));
  });

  function attempt(
    tenantPermittedHosts: readonly string[] | null,
    counter: { count: number },
    redis?: ClientCredentialsRedisLike,
  ) {
    return getClientCredentialsToken({
      tenantId: 'tenant-1',
      spaceId: 'space-1',
      bindingId: 'binding-1',
      auth: {
        tokenEndpoint: 'https://8.8.8.8/oauth/token',
        clientIdCredentialKey: 'test-client-id',
        clientSecretCredentialKey: 'test-client-secret',
      },
      credentialStore,
      ...(redis ? { redis } : {}),
      fetchImpl: makeFetch(
        {
          'https://8.8.8.8/oauth/token': {
            status: 200,
            body: { access_token: 'tok-1', expires_in: 3600 },
          },
        },
        counter,
      ),
      tenantPermittedHosts,
    });
  }

  it('blocks an uncovered token endpoint host before the exchange and before the cache', async () => {
    const counter = { count: 0 };
    const redis = makeFakeRedis();
    redis.store.set('aflow:mcp:oauth2:cc:tenant-1:binding-1:space-1', 'stale-cached-token');
    await expect(attempt(['*.kaggle.com'], counter, redis)).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'allowlist-host',
    });
    expect(counter.count).toBe(0);
  });

  it('exchanges when the permitted set covers the token endpoint host', async () => {
    const counter = { count: 0 };
    const result = await attempt(['8.8.8.8'], counter);
    expect(result.accessToken).toBe('tok-1');
    expect(counter.count).toBe(1);
  });

  it('exchanges without a permitted set (open mode)', async () => {
    const counter = { count: 0 };
    const result = await attempt(null, counter);
    expect(result.accessToken).toBe('tok-1');
  });
});
