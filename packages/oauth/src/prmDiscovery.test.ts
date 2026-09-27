import { describe, it, expect, beforeEach } from 'vitest';
import { discoverPRM, discoverPRMReactive, clearPrmCacheForTests } from './prmDiscovery.js';
import { discoverAsMetadata, clearAsCacheForTests } from './asMetadata.js';

interface MockResponse {
  status: number;
  body?: unknown;
  contentType?: string;
}

function makeFakeFetch(routes: Record<string, MockResponse>): typeof fetch {
  return (async (input: unknown): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const route = routes[url];
    if (!route) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: { 'content-type': route.contentType ?? 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const validPrm = {
  authorization_servers: ['https://203.0.113.5'],
  scopes_supported: ['read', 'write'],
};

describe('discoverPRM — pre-emptive discovery', () => {
  beforeEach(() => clearPrmCacheForTests());

  it('Path 2 canonical (/.well-known/oauth-protected-resource{path}) wins first', async () => {
    const fetchImpl = makeFakeFetch({
      'https://198.51.100.7/.well-known/oauth-protected-resource/mcp/v1': {
        status: 200,
        body: validPrm,
      },
    });
    const result = await discoverPRM('https://198.51.100.7/mcp/v1', { fetchImpl });
    expect(result.source).toBe('path-specific');
    expect(result.metadataUrl).toBe(
      'https://198.51.100.7/.well-known/oauth-protected-resource/mcp/v1',
    );
    expect(result.prm.authorization_servers).toEqual(['https://203.0.113.5']);
  });

  it('Path 2 alt ({path}/.well-known/...) when canonical 404s', async () => {
    const fetchImpl = makeFakeFetch({
      'https://198.51.100.7/mcp/v1/.well-known/oauth-protected-resource': {
        status: 200,
        body: validPrm,
      },
    });
    const result = await discoverPRM('https://198.51.100.7/mcp/v1', { fetchImpl });
    expect(result.source).toBe('path-specific-alt');
  });

  it('Path 3 root when Path 2 both 404', async () => {
    const fetchImpl = makeFakeFetch({
      'https://198.51.100.7/.well-known/oauth-protected-resource': {
        status: 200,
        body: validPrm,
      },
    });
    const result = await discoverPRM('https://198.51.100.7/mcp/v1', { fetchImpl });
    expect(result.source).toBe('root');
  });

  it('Path 3 honors definition.protectedResourceMetadataPath override', async () => {
    const fetchImpl = makeFakeFetch({
      'https://198.51.100.7/custom/prm.json': {
        status: 200,
        body: validPrm,
      },
    });
    const result = await discoverPRM('https://198.51.100.7', {
      fetchImpl,
      protectedResourceMetadataPath: '/custom/prm.json',
    });
    expect(result.source).toBe('root');
    expect(result.metadataUrl).toBe('https://198.51.100.7/custom/prm.json');
  });

  it('throws prm_discovery_failed when all three paths fail', async () => {
    const fetchImpl = makeFakeFetch({});
    await expect(discoverPRM('https://198.51.100.7/mcp/v1', { fetchImpl })).rejects.toThrow(
      /prm_discovery_failed/,
    );
  });

  it('rejects PRM whose `resource` origin does not match the server (RFC 9728 §3.3)', async () => {
    const fetchImpl = makeFakeFetch({
      'https://198.51.100.7/.well-known/oauth-protected-resource': {
        status: 200,
        body: { ...validPrm, resource: 'https://attacker.example.com/mcp' },
      },
    });
    await expect(discoverPRM('https://198.51.100.7', { fetchImpl })).rejects.toThrow(
      /prm_discovery_failed/,
    );
  });

  it('accepts PRM with matching resource origin', async () => {
    const fetchImpl = makeFakeFetch({
      'https://198.51.100.7/.well-known/oauth-protected-resource': {
        status: 200,
        body: { ...validPrm, resource: 'https://198.51.100.7/mcp/v1' },
      },
    });
    const result = await discoverPRM('https://198.51.100.7/mcp/v1', { fetchImpl });
    expect(result.prm.resource).toBe('https://198.51.100.7/mcp/v1');
  });

  it('falls through to next path when first PRM has a mismatched resource', async () => {
    const fetchImpl = makeFakeFetch({
      // Path 2 canonical returns a wrong-resource PRM (rejected)
      'https://198.51.100.7/.well-known/oauth-protected-resource/mcp/v1': {
        status: 200,
        body: {
          authorization_servers: ['https://evil-as.example.com'],
          resource: 'https://attacker/mcp',
        },
      },
      // Path 2 alt returns the correct PRM
      'https://198.51.100.7/mcp/v1/.well-known/oauth-protected-resource': {
        status: 200,
        body: { ...validPrm, resource: 'https://198.51.100.7/mcp/v1' },
      },
    });
    const result = await discoverPRM('https://198.51.100.7/mcp/v1', { fetchImpl });
    expect(result.source).toBe('path-specific-alt');
    expect(result.prm.authorization_servers).toEqual(['https://203.0.113.5']);
  });

  it('caches result and skips fetch on second call', async () => {
    let fetchCount = 0;
    const fetchImpl: typeof fetch = (async (input: unknown): Promise<Response> => {
      fetchCount++;
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === 'https://198.51.100.7/.well-known/oauth-protected-resource') {
        return new Response(JSON.stringify(validPrm), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    await discoverPRM('https://198.51.100.7', { fetchImpl });
    const firstCount = fetchCount;
    await discoverPRM('https://198.51.100.7', { fetchImpl });
    expect(fetchCount).toBe(firstCount); // no additional fetches on second call
  });
});

describe('discoverPRMReactive — WWW-Authenticate driven', () => {
  beforeEach(() => clearPrmCacheForTests());

  it('extracts PRM URL from WWW-Authenticate and fetches it', async () => {
    const fetchImpl = makeFakeFetch({
      'https://198.51.100.7/special-prm-location': {
        status: 200,
        body: validPrm,
      },
    });
    const result = await discoverPRMReactive(
      'https://198.51.100.7/mcp/v1',
      'Bearer resource_metadata="https://198.51.100.7/special-prm-location"',
      { fetchImpl },
    );
    expect(result?.source).toBe('www-authenticate');
    expect(result?.metadataUrl).toBe('https://198.51.100.7/special-prm-location');
  });

  it('returns null when WWW-Authenticate header has no resource_metadata', async () => {
    const fetchImpl = makeFakeFetch({});
    const result = await discoverPRMReactive(
      'https://198.51.100.7/mcp/v1',
      'Bearer realm="example", error="invalid_token"',
      { fetchImpl },
    );
    expect(result).toBeNull();
  });

  it('returns null when the advertised URL 404s', async () => {
    const fetchImpl = makeFakeFetch({});
    const result = await discoverPRMReactive(
      'https://198.51.100.7/mcp/v1',
      'Bearer resource_metadata="https://198.51.100.7/missing"',
      { fetchImpl },
    );
    expect(result).toBeNull();
  });
});

describe('discoverAsMetadata', () => {
  beforeEach(() => clearAsCacheForTests());

  const validAs = {
    issuer: 'https://203.0.113.5',
    authorization_endpoint: 'https://203.0.113.5/oauth/authorize',
    token_endpoint: 'https://203.0.113.5/oauth/token',
    code_challenge_methods_supported: ['S256'],
  };

  it('uses RFC 8414 path first', async () => {
    const fetchImpl = makeFakeFetch({
      'https://203.0.113.5/.well-known/oauth-authorization-server': {
        status: 200,
        body: validAs,
      },
    });
    const meta = await discoverAsMetadata('https://203.0.113.5', { fetchImpl });
    expect(meta.token_endpoint).toBe('https://203.0.113.5/oauth/token');
  });

  it('falls back to OIDC discovery when RFC 8414 404s', async () => {
    const fetchImpl = makeFakeFetch({
      'https://203.0.113.5/.well-known/openid-configuration': {
        status: 200,
        body: validAs,
      },
    });
    const meta = await discoverAsMetadata('https://203.0.113.5', { fetchImpl });
    expect(meta.token_endpoint).toBe('https://203.0.113.5/oauth/token');
  });

  it('throws when both paths 404', async () => {
    const fetchImpl = makeFakeFetch({});
    await expect(discoverAsMetadata('https://203.0.113.5', { fetchImpl })).rejects.toThrow(
      /as_metadata_discovery_failed/,
    );
  });

  it('rejects metadata missing required fields', async () => {
    const fetchImpl = makeFakeFetch({
      'https://203.0.113.5/.well-known/oauth-authorization-server': {
        status: 200,
        body: { issuer: 'https://203.0.113.5' }, // missing endpoints
      },
    });
    await expect(discoverAsMetadata('https://203.0.113.5', { fetchImpl })).rejects.toThrow(
      /as_metadata_discovery_failed/,
    );
  });

  it('strips trailing slash from issuer before building well-known URLs', async () => {
    const fetchImpl = makeFakeFetch({
      'https://203.0.113.5/.well-known/oauth-authorization-server': {
        status: 200,
        body: validAs,
      },
    });
    const meta = await discoverAsMetadata('https://203.0.113.5/', { fetchImpl });
    expect(meta.token_endpoint).toBe('https://203.0.113.5/oauth/token');
  });

  it('rejects metadata whose `issuer` does not match the discovery issuer (RFC 8414 §3.3)', async () => {
    const fetchImpl = makeFakeFetch({
      'https://203.0.113.5/.well-known/oauth-authorization-server': {
        status: 200,
        body: { ...validAs, issuer: 'https://attacker.example.com' },
      },
    });
    await expect(discoverAsMetadata('https://203.0.113.5', { fetchImpl })).rejects.toThrow(
      /as_metadata_discovery_failed/,
    );
  });

  it('accepts metadata whose `issuer` matches modulo trailing slash', async () => {
    const fetchImpl = makeFakeFetch({
      'https://203.0.113.5/.well-known/oauth-authorization-server': {
        status: 200,
        body: { ...validAs, issuer: 'https://203.0.113.5/' },
      },
    });
    const meta = await discoverAsMetadata('https://203.0.113.5', { fetchImpl });
    expect(meta.token_endpoint).toBe('https://203.0.113.5/oauth/token');
  });

  it('falls through to OIDC when RFC 8414 has a mismatched issuer', async () => {
    const fetchImpl = makeFakeFetch({
      'https://203.0.113.5/.well-known/oauth-authorization-server': {
        status: 200,
        body: { ...validAs, issuer: 'https://attacker.example.com' },
      },
      'https://203.0.113.5/.well-known/openid-configuration': {
        status: 200,
        body: validAs,
      },
    });
    const meta = await discoverAsMetadata('https://203.0.113.5', { fetchImpl });
    expect(meta.issuer).toBe('https://203.0.113.5');
  });
});

describe('discovery SSRF guard', () => {
  beforeEach(() => {
    clearPrmCacheForTests();
    clearAsCacheForTests();
  });

  function trackingFetch(
    calls: Array<{ url: string; init: RequestInit | undefined }>,
  ): typeof fetch {
    return (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({ url, init });
      return new Response(JSON.stringify(validPrm), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('discoverPRM rejects a loopback server origin before any fetch', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    await expect(
      discoverPRM('https://127.0.0.1/mcp', { fetchImpl: trackingFetch(calls) }),
    ).rejects.toMatchObject({ name: 'SsrfBlockedError', kind: 'private-ip' });
    expect(calls).toHaveLength(0);
  });

  it('discoverPRM rejects the cloud metadata origin', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    await expect(
      discoverPRM('https://169.254.169.254/mcp', { fetchImpl: trackingFetch(calls) }),
    ).rejects.toMatchObject({ name: 'SsrfBlockedError', kind: 'private-ip' });
    expect(calls).toHaveLength(0);
  });

  it('discoverPRMReactive refuses an advertised metadata URL on a private host', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const result = await discoverPRMReactive(
      'https://198.51.100.7/mcp',
      'Bearer resource_metadata="https://169.254.169.254/latest/meta-data"',
      { fetchImpl: trackingFetch(calls) },
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('discoverAsMetadata rejects a loopback issuer before any fetch', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    await expect(
      discoverAsMetadata('https://127.0.0.1', { fetchImpl: trackingFetch(calls) }),
    ).rejects.toMatchObject({ name: 'SsrfBlockedError', kind: 'private-ip' });
    expect(calls).toHaveLength(0);
  });

  it('discovery fetches refuse redirects', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    await discoverPRM('https://198.51.100.7/mcp', { fetchImpl: trackingFetch(calls) });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.init?.redirect).toBe('error');
    }
  });
});
