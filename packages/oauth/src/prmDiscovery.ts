import { safeFetchImpl, validateUrl } from '@aflow/network-safety';
import { parseWwwAuthenticateResourceMetadata } from './parseWwwAuth.js';

/**
 * RFC 9728 §3.2 — Protected Resource Metadata fields we depend on. The full
 * spec defines more; we extract the fields the token manager needs and pass
 * everything else through verbatim so caller-driven introspection still works.
 */
export interface ProtectedResourceMetadata {
  /** Authorization server URL(s). At least one is required. */
  authorization_servers?: string[];
  /** RFC 8707 audience to bind tokens to (defaults to the resource URL). */
  resource?: string;
  /** Supported scopes. Used to constrain `scope` parameter at consent. */
  scopes_supported?: string[];
  /** Bearer methods supported (header, body, query). We only use header. */
  bearer_methods_supported?: string[];
  [k: string]: unknown;
}

export type PrmDiscoverySource =
  'www-authenticate' | 'path-specific' | 'path-specific-alt' | 'root';

export interface PrmDiscoveryResult {
  prm: ProtectedResourceMetadata;
  source: PrmDiscoverySource;
  /** The URL that successfully returned the PRM document. */
  metadataUrl: string;
}

interface CacheEntry {
  prm: ProtectedResourceMetadata;
  source: PrmDiscoverySource;
  metadataUrl: string;
  fetchedAtMs: number;
}

const PRM_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

const prmCache = new Map<string, CacheEntry>();

export function clearPrmCacheForTests(): void {
  prmCache.clear();
}

export interface DiscoverPrmOptions {
  /** Override path on Path 3 (root well-known); per `McpServerDefinition.protectedResourceMetadataPath`. */
  protectedResourceMetadataPath?: string | undefined;
  /** Override fetch (for tests). Receives a URL string + RequestInit. */
  fetchImpl?: typeof fetch;
}

/**
 * Pre-emptive PRM discovery — tries Path 2 (path-specific well-known) then
 * Path 3 (root well-known). Throws when neither path returns a valid PRM.
 * Used by `mcp.binding.consent` to discover the AS before any token call.
 */
export async function discoverPRM(
  serverUrl: string,
  opts: DiscoverPrmOptions = {},
): Promise<PrmDiscoveryResult> {
  const url = new URL(serverUrl);
  const origin = url.origin;
  const path = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '';
  const cacheKey = `${origin}|${path}`;

  const cached = prmCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAtMs < PRM_CACHE_TTL_MS) {
    return { prm: cached.prm, source: cached.source, metadataUrl: cached.metadataUrl };
  }

  const fetchImpl = opts.fetchImpl ?? safeFetchImpl;

  // serverUrl is space-authored — SSRF-check its origin before any discovery
  // fetch. Every well-known URL below is origin-rooted.
  await validateUrl(origin, []);

  // Path 2 — path-specific well-known. Two layouts in the wild:
  //   canonical:   {origin}/.well-known/oauth-protected-resource{path}
  //   alt:         {origin}{path}/.well-known/oauth-protected-resource
  if (path) {
    const canonicalUrl = `${origin}/.well-known/oauth-protected-resource${path}`;
    const canonical = await tryFetch(fetchImpl, canonicalUrl);
    if (canonical && validatePrmResource(canonical, serverUrl)) {
      return cacheAndReturn(cacheKey, canonical, 'path-specific', canonicalUrl);
    }

    const altUrl = `${origin}${path}/.well-known/oauth-protected-resource`;
    const alt = await tryFetch(fetchImpl, altUrl);
    if (alt && validatePrmResource(alt, serverUrl)) {
      return cacheAndReturn(cacheKey, alt, 'path-specific-alt', altUrl);
    }
  }

  // Path 3 — root well-known (with optional override path).
  const rootPath = opts.protectedResourceMetadataPath ?? '/.well-known/oauth-protected-resource';
  const rootUrl = `${origin}${rootPath.startsWith('/') ? rootPath : `/${rootPath}`}`;
  const root = await tryFetch(fetchImpl, rootUrl);
  if (root && validatePrmResource(root, serverUrl)) {
    return cacheAndReturn(cacheKey, root, 'root', rootUrl);
  }

  throw new Error(
    `prm_discovery_failed: no Protected Resource Metadata document found at ` +
      `path-specific or root well-known for server "${serverUrl}". Tried: ${path ? '2 path-specific paths and ' : ''}1 root path.`,
  );
}

/**
 * RFC 9728 §3.3 — verify the PRM's `resource` field corresponds to the
 * resource server URL we're discovering. Origin match is sufficient: the
 * MCP server URL `serverUrl` and the PRM's `resource` MUST share the same
 * origin (scheme + host + port). When `resource` is absent the PRM is
 * accepted (older / minimal PRMs may omit it); when present and mismatched
 * the document is rejected with a warning.
 *
 * This is the primary defense against a compromised MCP server emitting a
 * `WWW-Authenticate: Bearer resource_metadata="..."` pointing at an
 * attacker-controlled PRM that lists an attacker AS — without this check,
 * we'd direct user consent (and the resulting tokens) to the wrong AS.
 */
function validatePrmResource(prm: ProtectedResourceMetadata, serverUrl: string): boolean {
  if (!prm.resource) return true; // optional per spec
  let prmOrigin: string;
  let serverOrigin: string;
  try {
    prmOrigin = new URL(prm.resource).origin;
    serverOrigin = new URL(serverUrl).origin;
  } catch {
    console.warn(
      `[prm] rejecting PRM document — invalid URL in resource field or serverUrl. prm.resource=${prm.resource} serverUrl=${serverUrl}`,
    );
    return false;
  }
  if (prmOrigin !== serverOrigin) {
    console.warn(
      `[prm] rejecting PRM document — resource origin "${prmOrigin}" does not match server origin "${serverOrigin}". This may indicate a misdirection attack.`,
    );
    return false;
  }
  return true;
}

/**
 * Reactive PRM discovery — given the `WWW-Authenticate` header from a 401,
 * fetch the PRM at the URL it advertises. Bypasses cache (the header is
 * authoritative); on success, populates the cache so subsequent pre-emptive
 * calls for the same server skip the round-trip.
 */
export async function discoverPRMReactive(
  serverUrl: string,
  wwwAuthenticate: string | null | undefined,
  opts: DiscoverPrmOptions = {},
): Promise<PrmDiscoveryResult | null> {
  const url = parseWwwAuthenticateResourceMetadata(wwwAuthenticate);
  if (!url) return null;

  // The advertised URL comes from the server's own 401 header and can point
  // anywhere — SSRF-check it before fetching. Reactive discovery is
  // best-effort, so a blocked URL degrades to pre-emptive discovery.
  try {
    await validateUrl(url, []);
  } catch (err) {
    console.warn(
      `[prm] rejecting advertised resource_metadata URL "${url}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const fetchImpl = opts.fetchImpl ?? safeFetchImpl;
  const prm = await tryFetch(fetchImpl, url);
  if (!prm) return null;

  // Reactive path is the most dangerous: the URL came from the server itself,
  // so a compromised server can advertise a PRM that lists an attacker AS.
  // RFC 9728 §3.3 validation is the primary defense.
  if (!validatePrmResource(prm, serverUrl)) return null;

  const serverOrigin = new URL(serverUrl).origin;
  const path =
    new URL(serverUrl).pathname && new URL(serverUrl).pathname !== '/'
      ? new URL(serverUrl).pathname.replace(/\/$/, '')
      : '';
  const cacheKey = `${serverOrigin}|${path}`;
  return cacheAndReturn(cacheKey, prm, 'www-authenticate', url);
}

async function tryFetch(
  fetchImpl: typeof fetch,
  url: string,
): Promise<ProtectedResourceMetadata | null> {
  let response: Response;
  try {
    // No redirects — a redirect would hop to a host the guard never checked.
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  return body as ProtectedResourceMetadata;
}

function cacheAndReturn(
  key: string,
  prm: ProtectedResourceMetadata,
  source: PrmDiscoverySource,
  metadataUrl: string,
): PrmDiscoveryResult {
  prmCache.set(key, { prm, source, metadataUrl, fetchedAtMs: Date.now() });
  return { prm, source, metadataUrl };
}
