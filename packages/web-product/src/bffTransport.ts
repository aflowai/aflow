/**
 * The browser-facing proxy, as the product rather than as one application's route.
 *
 * Every application composes the same transport and differs only in the identity
 * it hands over: the hosted one attaches an access token it got from a session,
 * the local one attaches the instance secret after checking the request reached
 * it the only way it may. Neither branch is spelled here, which is the point —
 * the edition conditionals this replaces were spread across four call sites, and
 * one of them omitted a check another performed.
 *
 * Stated in `Request` and `Response`, not the framework's subclasses. A Next
 * route handler accepts and returns these, and a package that named its types
 * would make the product depend on the application's framework.
 */
import type { UpstreamAuthorization, WebIdentity } from './webIdentity.js';
import { PROXY_RESPONSE_HEADER } from './proxyResponseHeader.js';

/** What an application tells the transport about the deployment it sits in. */
export interface TransportConfig {
  /** Where the API answers. */
  apiUrl: string;

  /**
   * The shared secret that proves a request came from this proxy rather than
   * from the internet. Absent when nothing sits in front of the origin; the API
   * trusts a forwarded client IP only when it matches.
   */
  originSecret?: string | undefined;

  /**
   * Whether a tenant selector may be forwarded.
   *
   * `false` for an API that pins one tenant and refuses a request naming
   * another, where a stale selector would fail every call rather than choose
   * anything.
   */
  forwardTenantSelector: boolean;

  /** The selector to use when none arrives on the request and forwarding is allowed. */
  defaultTenantId?: string | undefined;
}

/**
 * Upstream routes reachable with no credential, because the API serves them that
 * way. A missing session must not fail these; everything else needs one.
 */
export function allowsAnonymous(method: string, path: string): boolean {
  return method === 'POST' && path === '/v1/invite-requests';
}

/**
 * Response headers the browser is allowed to see.
 *
 * Copied by name rather than wholesale: everything upstream sets travels back
 * through here, and a `Set-Cookie` or an auth echo forwarded by accident would
 * be attributed to this origin. The byte-serving four (`Content-Range`,
 * `Accept-Ranges`, `ETag`, `Cache-Control`) are what let a media element seek —
 * without them a 206 reaches the page as a truncated 200.
 */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-range',
  'accept-ranges',
  'etag',
  'cache-control',
  'content-disposition',
] as const;

/**
 * Request headers forwarded by name, each for a reason that breaks without it.
 *
 * `Range`/`If-Range`: a media element asks for the slice it is about to play and
 * re-asks on every seek, and dropping them answers each with the whole asset —
 * which makes the upstream 206 path unreachable from a browser.
 * `If-None-Match`: without it a validator the client already holds never reaches
 * the origin, so an immutable resource is re-sent in full on every read.
 */
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'idempotency-key',
  'last-event-id',
  'range',
  'if-range',
  'if-none-match',
] as const;

function jsonResponse(status: number, error: string, message: string): Response {
  // Every response the proxy answers with itself passes through here, and an
  // upstream one never does — so this is where the two become distinguishable to
  // a caller that must not read a proxy failure as proof of authentication.
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json', [PROXY_RESPONSE_HEADER]: '1' },
  });
}

/**
 * What the API needs to place a server-to-server call, whoever is making it.
 *
 * Every call from this application reaches the same origin, and the edge in
 * front of it refuses one that carries no origin secret. Anything assembling
 * these by hand answers a 403 as though the API had said no.
 */
export function upstreamHeaders(source: {
  /** Shared with the edge; the API trusts `X-Client-IP` only behind it. */
  originSecret?: string | undefined;
  /** The browser's own address. Without it a per-IP limit keys on this
   * deployment's egress and collapses every visitor into one bucket. */
  clientIp?: string | null | undefined;
  /** The `Authorization` value, where this caller has one. */
  authorization?: string | undefined;
}): Headers {
  const headers = new Headers();
  if (source.originSecret !== undefined && source.originSecret !== '') {
    headers.set('X-Origin-Verify', source.originSecret);
  }
  const clientIp = source.clientIp?.trim();
  if (clientIp !== undefined && clientIp !== '') headers.set('X-Client-IP', clientIp);
  if (source.authorization !== undefined) headers.set('Authorization', source.authorization);
  return headers;
}

/** The address a browser request arrived from, as the edge reported it. */
export function clientIpOf(headers: Headers): string | null {
  return headers.get('x-real-ip') ?? headers.get('x-forwarded-for')?.split(',')[0] ?? null;
}

function buildHeaders(
  request: Request,
  config: TransportConfig,
  authorization: UpstreamAuthorization,
): Headers {
  const headers = upstreamHeaders({
    originSecret: config.originSecret,
    clientIp: clientIpOf(request.headers),
    ...(authorization.kind === 'authorized' ? { authorization: authorization.header } : {}),
  });

  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const space = request.headers.get('X-Space-ID');
  if (space !== null) headers.set('X-Space-ID', space);

  if (config.forwardTenantSelector) {
    const tenant = request.headers.get('X-Tenant-ID') ?? config.defaultTenantId;
    if (tenant !== undefined && tenant !== '') headers.set('X-Tenant-ID', tenant);
  }

  return headers;
}

/**
 * Forward one browser request to the API under the composed identity.
 *
 * The order is load-bearing. Whether the request may proceed is settled before
 * any credential is attached, so a request that arrived under someone else's
 * name is never forwarded as the owner.
 */
export async function proxyToApi(
  request: Request,
  identity: WebIdentity,
  config: TransportConfig,
): Promise<Response> {
  const permitted = await identity.admitRequest(request);
  switch (permitted.kind) {
    case 'refused':
      return jsonResponse(403, 'Forbidden', permitted.reason);
    case 'unavailable':
      return jsonResponse(503, 'ServiceUnavailable', permitted.reason);
    case 'authorized':
      break;
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '/v1');

  // Inside an error boundary because obtaining a credential can fail outright: a
  // token provider that is down throws rather than answering, and before this
  // moved out of the route it was inside the same `try` that answers 502. Left
  // outside, such a failure escapes the handler as a generic 500.
  let authorization;
  try {
    authorization = await identity.authorizeUpstream({
      anonymousOk: allowsAnonymous(request.method, path),
    });
  } catch (error) {
    console.error('[bff] could not obtain an upstream credential:', error);
    return jsonResponse(502, 'BadGateway', 'Failed to authorize the request upstream');
  }
  // "No credential" and "cannot get one" are different answers, and only the
  // first may proceed. Treating the second as the first reaches the API
  // unauthenticated, and every call 401s with nothing naming the cause.
  if (authorization.kind === 'unavailable') {
    return jsonResponse(503, 'ServiceUnavailable', authorization.reason);
  }
  if (authorization.kind === 'unauthenticated') {
    return jsonResponse(401, 'Unauthorized', 'Authentication required');
  }

  const fetchOptions: RequestInit = {
    method: request.method,
    headers: buildHeaders(request, config, authorization),
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    fetchOptions.body = request.body;
    // Required for a streamed request body on Node, and absent from the DOM type.
    Reflect.set(fetchOptions, 'duplex', 'half');
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.apiUrl}${path}${url.search}`, fetchOptions);
  } catch (error) {
    console.error('[bff] upstream request failed:', error);
    return jsonResponse(502, 'BadGateway', 'Failed to reach API server');
  }

  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');

  // `Content-Length` is deliberately absent: `fetch` decodes a compressed body,
  // so the upstream figure can describe bytes the browser never receives. A 206
  // carries its own count in `Content-Range`.
  return new Response(upstream.body, { status: upstream.status, headers });
}
