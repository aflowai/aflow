/**
 * What the browser-facing proxy does, pinned per outcome.
 *
 * The transport moved out of one application's route file, and the appliance
 * serves that application — so a difference here is a difference in the product.
 * The anonymous case is the one that motivated the suite: a central session gate
 * would have turned away the single route that exists for visitors who do not
 * have a session yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { proxyToApi, type TransportConfig } from './bffTransport.js';
import { PROXY_RESPONSE_HEADER } from './proxyResponseHeader.js';
import type {
  Admission,
  RequestAuthorization,
  UpstreamAuthorization,
  WebIdentity,
} from './webIdentity.js';

const CONFIG: TransportConfig = {
  apiUrl: 'http://api.test',
  originSecret: 'origin-secret',
  forwardTenantSelector: true,
  defaultTenantId: 'tenant-default',
};

function identity(overrides: Partial<WebIdentity> = {}): WebIdentity {
  return {
    name: 'test',
    authorizeUpstream: () =>
      Promise.resolve({ kind: 'authorized', header: 'Bearer token' } as UpstreamAuthorization),
    processRequest: () => Promise.resolve(new Response(null, { status: 204 })),
    admitRequest: () => Promise.resolve({ kind: 'authorized' } as Admission),
    authenticateRequest: () => Promise.resolve({ kind: 'authorized' } as RequestAuthorization),
    configurationViolations: () => [],
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response('{"ok":true}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          etag: 'W/"1"',
          'set-cookie': 'upstream=1',
          'content-length': '11',
          'x-internal': 'leak',
        },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The browser addresses `/api/...`; the transport rewrites that prefix to `/v1`,
// so a fixture naming `/api/v1/...` would arrive upstream as `/v1/v1/...`.
const get = (url = 'http://web.test/api/things') => new Request(url);

describe('admission', () => {
  it('refuses with the reason the identity gave', async () => {
    const response = await proxyToApi(
      get(),
      identity({
        admitRequest: () => Promise.resolve({ kind: 'refused', reason: 'Host not local' }),
      }),
      CONFIG,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ message: 'Host not local' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a process that cannot serve as unavailable, not as a refusal', async () => {
    const response = await proxyToApi(
      get(),
      identity({
        admitRequest: () => Promise.resolve({ kind: 'unavailable', reason: 'no secret' }),
      }),
      CONFIG,
    );
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Settled before the credential is attached, so a request that arrived under
  // another name is never forwarded as the owner.
  it('never forwards when admission fails', async () => {
    const authorizeUpstream = vi.fn();
    await proxyToApi(
      get(),
      identity({
        admitRequest: () => Promise.resolve({ kind: 'refused', reason: 'nope' }),
        authorizeUpstream: authorizeUpstream as unknown as WebIdentity['authorizeUpstream'],
      }),
      CONFIG,
    );
    expect(authorizeUpstream).not.toHaveBeenCalled();
  });
});

describe('the upstream credential', () => {
  it('attaches the header the identity returned', async () => {
    await proxyToApi(get(), identity(), CONFIG);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer token');
  });

  // The route that exists for people who have no session yet.
  it('forwards a route the API serves anonymously with no credential', async () => {
    const seen: { anonymousOk: boolean }[] = [];
    await proxyToApi(
      new Request('http://web.test/api/invite-requests', { method: 'POST' }),
      identity({
        authorizeUpstream: (options) => {
          seen.push(options);
          return Promise.resolve({ kind: 'anonymous' });
        },
      }),
      CONFIG,
    );
    expect(seen).toEqual([{ anonymousOk: true }]);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.has('Authorization')).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not treat any other route as anonymous', async () => {
    const seen: { anonymousOk: boolean }[] = [];
    await proxyToApi(
      get(),
      identity({
        authorizeUpstream: (options) => {
          seen.push(options);
          return Promise.resolve({ kind: 'authorized', header: 'Bearer t' });
        },
      }),
      CONFIG,
    );
    expect(seen).toEqual([{ anonymousOk: false }]);
  });

  it('answers a lost session with 401 and a broken deployment with 503', async () => {
    const unauthenticated = await proxyToApi(
      get(),
      identity({ authorizeUpstream: () => Promise.resolve({ kind: 'unauthenticated' }) }),
      CONFIG,
    );
    expect(unauthenticated.status).toBe(401);

    const unavailable = await proxyToApi(
      get(),
      identity({
        authorizeUpstream: () => Promise.resolve({ kind: 'unavailable', reason: 'misconfigured' }),
      }),
      CONFIG,
    );
    expect(unavailable.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('what crosses in each direction', () => {
  it('rewrites the api prefix and keeps the query', async () => {
    await proxyToApi(get('http://web.test/api/things?a=1&b=2'), identity(), CONFIG);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://api.test/v1/things?a=1&b=2');
  });

  it('sends the origin secret and the browser address, not this proxy egress', async () => {
    const request = new Request('http://web.test/api/things', {
      headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' },
    });
    await proxyToApi(request, identity(), CONFIG);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('X-Origin-Verify')).toBe('origin-secret');
    expect(headers.get('X-Client-IP')).toBe('203.0.113.9');
  });

  it('forwards the headers a media element seeks with', async () => {
    const request = new Request('http://web.test/api/things', {
      headers: { range: 'bytes=0-99', 'if-range': 'W/"1"', 'if-none-match': 'W/"2"' },
    });
    await proxyToApi(request, identity(), CONFIG);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('range')).toBe('bytes=0-99');
    expect(headers.get('if-range')).toBe('W/"1"');
    expect(headers.get('if-none-match')).toBe('W/"2"');
  });

  it('omits the tenant selector for an API that pins one', async () => {
    const request = new Request('http://web.test/api/things', {
      headers: { 'X-Tenant-ID': 'someone-else' },
    });
    await proxyToApi(request, identity(), { ...CONFIG, forwardTenantSelector: false });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.has('X-Tenant-ID')).toBe(false);
  });

  it('falls back to the configured selector when forwarding is allowed', async () => {
    await proxyToApi(get(), identity(), CONFIG);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('X-Tenant-ID')).toBe('tenant-default');
  });

  // Everything upstream sets travels back through here, so the list is what the
  // browser may see rather than what arrived.
  it('returns only the named response headers', async () => {
    const response = await proxyToApi(get(), identity(), CONFIG);
    expect(response.headers.get('etag')).toBe('W/"1"');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has('x-internal')).toBe(false);
  });

  // `fetch` decodes a compressed body, so the upstream figure can describe bytes
  // the browser never receives.
  it('never claims a content length of its own', async () => {
    const response = await proxyToApi(get(), identity(), CONFIG);
    expect(response.headers.has('content-length')).toBe(false);
  });

  it('answers an unreachable API with 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    const response = await proxyToApi(get(), identity(), CONFIG);
    expect(response.status).toBe(502);
  });
});

describe('who answered', () => {
  /**
   * A caller cannot tell a proxy failure from an upstream one by status alone —
   * the proxy's 503 means it could not obtain a credential, while the API's
   * `NotAdmitted` 503 means it got one. Session recovery reads this signal before
   * treating a response as proof the credential was accepted, so a response that
   * never left the proxy has to say so.
   */
  it('marks a response the proxy produced instead of forwarding', async () => {
    const response = await proxyToApi(
      get(),
      identity({
        authorizeUpstream: () => Promise.resolve({ kind: 'unavailable', reason: 'no credential' }),
      }),
      CONFIG,
    );
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get(PROXY_RESPONSE_HEADER)).not.toBeNull();
  });

  it('marks a refusal the same way', async () => {
    const response = await proxyToApi(
      get(),
      identity({ admitRequest: () => Promise.resolve({ kind: 'refused', reason: 'not local' }) }),
      CONFIG,
    );
    expect(response.headers.get(PROXY_RESPONSE_HEADER)).not.toBeNull();
  });

  it('leaves an upstream response unmarked, so its status speaks for the API', async () => {
    const response = await proxyToApi(get(), identity(), CONFIG);
    expect(fetchMock).toHaveBeenCalled();
    expect(response.headers.get(PROXY_RESPONSE_HEADER)).toBeNull();
  });
});
