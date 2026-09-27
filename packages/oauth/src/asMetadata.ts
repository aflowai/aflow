import { safeFetchImpl, validateUrl } from '@aflow/network-safety';

/**
 * Subset of RFC 8414 / OIDC discovery fields we depend on. Other fields are
 * preserved on the returned object so caller-driven introspection still works.
 */
export interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  /** Token endpoint auth methods supported. We require `none` for PKCE. */
  token_endpoint_auth_methods_supported?: string[];
  /** PKCE code challenge methods. We require `S256`. */
  code_challenge_methods_supported?: string[];
  /** Grant types supported. We require `authorization_code` + `refresh_token`. */
  grant_types_supported?: string[];
  /** Scopes the AS advertises. */
  scopes_supported?: string[];
  [k: string]: unknown;
}

interface CacheEntry {
  metadata: AsMetadata;
  fetchedAtMs: number;
}

const AS_CACHE_TTL_MS = 60 * 60 * 1000;
const asCache = new Map<string, CacheEntry>();

export function clearAsCacheForTests(): void {
  asCache.clear();
}

export interface DiscoverAsMetadataOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Discover the AS metadata. Tries RFC 8414, then OIDC discovery.
 * Throws when neither path returns a usable document.
 */
export async function discoverAsMetadata(
  issuer: string,
  opts: DiscoverAsMetadataOptions = {},
): Promise<AsMetadata> {
  const normalizedIssuer = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  const cached = asCache.get(normalizedIssuer);
  if (cached && Date.now() - cached.fetchedAtMs < AS_CACHE_TTL_MS) {
    return cached.metadata;
  }

  const fetchImpl = opts.fetchImpl ?? safeFetchImpl;

  // The issuer can be space-authored (pinned AS, PRM-discovered) — SSRF-check
  // it before any discovery fetch. All discovery URLs below are issuer-rooted.
  await validateUrl(normalizedIssuer, []);

  // RFC 8414 first.
  const rfc8414Url = `${normalizedIssuer}/.well-known/oauth-authorization-server`;
  const rfc8414 = await tryFetchAsMetadata(fetchImpl, rfc8414Url);
  if (rfc8414 && validateIssuer(rfc8414, normalizedIssuer)) {
    asCache.set(normalizedIssuer, { metadata: rfc8414, fetchedAtMs: Date.now() });
    return rfc8414;
  }

  // OIDC discovery fallback.
  const oidcUrl = `${normalizedIssuer}/.well-known/openid-configuration`;
  const oidc = await tryFetchAsMetadata(fetchImpl, oidcUrl);
  if (oidc && validateIssuer(oidc, normalizedIssuer)) {
    asCache.set(normalizedIssuer, { metadata: oidc, fetchedAtMs: Date.now() });
    return oidc;
  }

  throw new Error(
    `as_metadata_discovery_failed: neither ${rfc8414Url} nor ${oidcUrl} returned a valid metadata document.`,
  );
}

/**
 * RFC 8414 §3.3 — verify `meta.issuer` matches the issuer we discovered from.
 * Trailing-slash normalized on both sides so `https://as.example.com` and
 * `https://as.example.com/` are equivalent. Mismatches signal a misdirected
 * discovery (compromised PRM, typo in binding.auth.authorizationServer) and
 * are rejected with a warning.
 */
function validateIssuer(meta: AsMetadata, normalizedIssuer: string): boolean {
  const metaIssuer = meta.issuer.endsWith('/') ? meta.issuer.slice(0, -1) : meta.issuer;
  if (metaIssuer !== normalizedIssuer) {
    console.warn(
      `[as-metadata] rejecting metadata — meta.issuer "${metaIssuer}" does not match discovery issuer "${normalizedIssuer}". This may indicate a misdirected discovery.`,
    );
    return false;
  }
  return true;
}

async function tryFetchAsMetadata(
  fetchImpl: typeof fetch,
  url: string,
): Promise<AsMetadata | null> {
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
  const meta = body as AsMetadata;
  // Minimum required fields per RFC 8414 / OIDC core for our use case.
  if (
    typeof meta.issuer !== 'string' ||
    typeof meta.authorization_endpoint !== 'string' ||
    typeof meta.token_endpoint !== 'string'
  ) {
    return null;
  }
  return meta;
}
