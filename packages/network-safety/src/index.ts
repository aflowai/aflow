/**
 * SSRF / egress guardrails for credential-bearing outbound requests.
 *
 * Non-negotiable runtime checks:
 * - Block private network ranges (RFC 1918, link-local, metadata IPs)
 * - DNS rebinding defense: resolve host → verify IP not private
 * - Allowlist-based host filtering
 * - Method restrictions
 * - Redirect safety (no cross-host by default)
 */
import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { URL } from 'node:url';

// ============================================================================
// Private / Reserved IP Ranges
// ============================================================================

const BLOCKED_CIDRS: Array<{ prefix: bigint; mask: bigint; label: string }> = buildBlockedCidrs();

function buildBlockedCidrs() {
  function cidr(addr: string, bits: number, label: string) {
    const parts = addr.split('.').map(Number);
    const ip =
      (BigInt(parts[0]!) << 24n) |
      (BigInt(parts[1]!) << 16n) |
      (BigInt(parts[2]!) << 8n) |
      BigInt(parts[3]!);
    const mask = bits === 0 ? 0n : ((1n << 32n) - 1n) << BigInt(32 - bits);
    return { prefix: ip & mask, mask, label };
  }

  return [
    cidr('0.0.0.0', 8, 'current-network'),
    cidr('10.0.0.0', 8, 'private-rfc1918'),
    cidr('100.64.0.0', 10, 'shared-address-space'),
    cidr('127.0.0.0', 8, 'loopback'),
    cidr('169.254.0.0', 16, 'link-local'),
    cidr('169.254.169.254', 32, 'cloud-metadata'),
    cidr('172.16.0.0', 12, 'private-rfc1918'),
    cidr('192.0.0.0', 24, 'ietf-protocol'),
    cidr('192.168.0.0', 16, 'private-rfc1918'),
    cidr('198.18.0.0', 15, 'benchmark'),
    cidr('224.0.0.0', 4, 'multicast'),
    cidr('240.0.0.0', 4, 'reserved'),
    cidr('255.255.255.255', 32, 'broadcast'),
  ];
}

/**
 * Only the canonical dotted quad, and `isIPv4` is the single authority on what
 * that means — a second hand-written notion of "looks like an IP" is how the
 * two drift apart.
 *
 * The parse must not be more permissive than the resolver every caller
 * ultimately reaches. `Number('0177')` is 177, while `getaddrinfo` reads the
 * same text as octal 127: a lenient parse range-checks a different address
 * than the one that gets dialled, so `0177.0.0.1` clears a loopback check and
 * then connects to loopback.
 */
function canonicalIpv4ToBigInt(ip: string): bigint | null {
  if (!isIPv4(ip)) return null;
  let result = 0n;
  for (const part of ip.split('.')) {
    result = (result << 8n) | BigInt(Number(part));
  }
  return result;
}

export function isPrivateIp(ip: string): { blocked: boolean; label?: string } {
  const numeric = canonicalIpv4ToBigInt(ip);
  if (numeric === null) {
    // Fail closed. BLOCKED_CIDRS is IPv4 and resolution is pinned to family 4,
    // so this function has no meaningful coverage of any other address form —
    // an IPv6 literal, a non-canonical quad, a bare integer. Returning "not
    // private" for input it cannot evaluate reports absence of knowledge as
    // absence of risk, which is the only way this guard can be wrong in the
    // dangerous direction.
    return { blocked: true, label: 'unrecognized-address-form' };
  }

  for (const cidr of BLOCKED_CIDRS) {
    if ((numeric & cidr.mask) === cidr.prefix) {
      return { blocked: true, label: cidr.label };
    }
  }
  return { blocked: false };
}

// ============================================================================
// DNS Resolution with Rebinding Defense
// ============================================================================

/** `URL.hostname` renders an IPv6 host bracketed; `net.isIPv6` does not accept that form. */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * One component of an `inet_aton`-style numeric address: decimal, octal via a
 * leading zero, or hex via `0x`.
 */
const NUMERIC_ADDRESS_PART = /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/;

/**
 * Whether the text is an attempt to write an address numerically, in any of
 * the spellings `inet_aton` accepts — including the short forms (`127.1`) and
 * the bare 32-bit integer.
 *
 * Used to refuse such spellings rather than resolve them, because resolvers do
 * not agree on what they mean: glibc reads `0177.0.0.1` as octal 127.0.0.1,
 * macOS reads it as 177.0.0.1. Delegating the interpretation would make this
 * guard's verdict depend on the libc underneath it — safe on the machine the
 * tests run on, and something else in production. No legitimate DNS name has
 * this shape, so there is nothing to lose by refusing it.
 */
function looksLikeNumericAddress(hostname: string): boolean {
  const parts = hostname.split('.');
  return parts.length <= 4 && parts.every((part) => NUMERIC_ADDRESS_PART.test(part));
}

export interface ResolvedHost {
  hostname: string;
  ip: string;
  family: 4 | 6;
}

/**
 * Resolve hostname and validate the IP is not in a private/reserved range.
 *
 * Policy: IPv4-only resolution (`family: 4`). This is intentional — IPv6 private
 * ranges (fc00::/7, fe80::/10) are harder to enumerate exhaustively, and most
 * external APIs serve over IPv4. If IPv6 support is needed, extend BLOCKED_CIDRS
 * to cover all RFC 4193 / RFC 6890 ranges.
 */
export async function resolveAndValidateHost(hostname: string): Promise<ResolvedHost> {
  // An IPv6 literal is refused outright rather than range-checked, because
  // BLOCKED_CIDRS describes no IPv6 range — and the alternative, a bespoke
  // IPv6 parser inside the guard, is a place where one subtle bug is a bypass.
  //
  // Matched on the address inside the brackets: callers arrive from
  // `URL.hostname`, which keeps them (`http://[::1]/` yields the seven-character
  // string `[::1]`), and `isIPv6` does not accept that form. Testing the raw
  // hostname would leave this branch unreachable and the refusal delegated to
  // getaddrinfo happening to reject a name containing brackets.
  if (isIPv6(stripIpv6Brackets(hostname))) {
    throw new SsrfBlockedError(`Blocked: IPv6 literal ${hostname} is not permitted`, hostname, {
      kind: 'private-ip',
      rangeLabel: 'ipv6-literal',
    });
  }

  // Only the canonical dotted quad may skip DNS — the one spelling this
  // process and the resolver are guaranteed to read the same way.
  if (isIPv4(hostname)) {
    const check = isPrivateIp(hostname);
    if (check.blocked) {
      throw new SsrfBlockedError(
        `Blocked: IP ${hostname} is in a private/reserved range (${check.label ?? 'unknown'})`,
        hostname,
        { kind: 'private-ip', ...(check.label ? { rangeLabel: check.label } : {}) },
      );
    }
    return { hostname, ip: hostname, family: 4 };
  }

  if (looksLikeNumericAddress(hostname)) {
    throw new SsrfBlockedError(
      `Blocked: ${hostname} is a non-canonical numeric address; write it as a dotted quad`,
      hostname,
      { kind: 'private-ip', rangeLabel: 'non-canonical-numeric' },
    );
  }

  try {
    const result = await lookup(hostname, { family: 4 });
    const check = isPrivateIp(result.address);
    if (check.blocked) {
      throw new SsrfBlockedError(
        `DNS rebinding blocked: ${hostname} resolved to private IP ${result.address} (${check.label ?? 'unknown'})`,
        hostname,
        { kind: 'private-ip', ...(check.label ? { rangeLabel: check.label } : {}) },
      );
    }
    return { hostname, ip: result.address, family: result.family as 4 | 6 };
  } catch (err) {
    if (err instanceof SsrfBlockedError) throw err;
    throw new DnsBlockedError(
      `DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
      hostname,
    );
  }
}

// ============================================================================
// Host Allowlist Validation
// ============================================================================

export function isHostAllowed(hostname: string, allowedHosts: string[]): boolean {
  for (const pattern of allowedHosts) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      if (hostname === pattern.slice(2) || hostname.endsWith(suffix)) {
        return true;
      }
    } else if (hostname === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a required host — possibly itself a `*.suffix` wildcard pattern — is
 * fully covered by an allow-pattern list. A literal host matches under
 * `isHostAllowed` semantics; a wildcard is only covered by an equal-or-wider
 * wildcard (a literal allow entry can never cover a wildcard requirement).
 */
export function isHostPatternCovered(
  hostOrPattern: string,
  allowPatterns: readonly string[],
): boolean {
  const target = hostOrPattern.toLowerCase();
  const patterns = allowPatterns.map((p) => p.toLowerCase());
  if (target.startsWith('*.')) {
    const suffix = target.slice(2);
    return patterns.some((pattern) => {
      if (!pattern.startsWith('*.')) return false;
      const allowSuffix = pattern.slice(2);
      return suffix === allowSuffix || suffix.endsWith(`.${allowSuffix}`);
    });
  }
  return isHostAllowed(target, patterns);
}

/** The subset of `hosts` not covered by `allowPatterns` (order-preserving, deduped). */
export function uncoveredHosts(
  hosts: readonly string[],
  allowPatterns: readonly string[],
): string[] {
  const denied: string[] = [];
  for (const host of hosts) {
    if (!isHostPatternCovered(host, allowPatterns) && !denied.includes(host)) {
      denied.push(host);
    }
  }
  return denied;
}

// ============================================================================
// URL Validation
// ============================================================================

export interface ValidatedUrl {
  url: URL;
  resolvedHost: ResolvedHost;
}

export async function validateUrl(rawUrl: string, allowedHosts: string[]): Promise<ValidatedUrl> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${rawUrl}`, rawUrl, { kind: 'invalid-url' });
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SsrfBlockedError(
      `Blocked: protocol ${parsed.protocol} not allowed (only http/https)`,
      rawUrl,
      { kind: 'invalid-protocol' },
    );
  }

  if (allowedHosts.length > 0 && !isHostAllowed(parsed.hostname, allowedHosts)) {
    throw new SsrfBlockedError(`Blocked: host ${parsed.hostname} not in allowlist`, rawUrl, {
      kind: 'allowlist-host',
    });
  }

  const resolvedHost = await resolveAndValidateHost(parsed.hostname);
  return { url: parsed, resolvedHost };
}

/**
 * Validate a URL that will carry credentials (secrets in the body or auth
 * headers): require https before any DNS work so the rejection is
 * deterministic, then run the full SSRF checks. Callers must also refuse
 * redirects on the request itself (`redirect: 'error'`) — a redirected
 * credentialed request re-sends the secret elsewhere.
 *
 * Callers fetch by hostname AFTER this check, so the DNS validation alone is
 * TOCTOU-racable; https-only is what closes it — TLS server-certificate
 * validation defeats a rebind to another origin (the same split that has the
 * api executor pin http fetches to the resolved IP but fetch https by name).
 */
export async function validateCredentialedUrl(rawUrl: string): Promise<ValidatedUrl> {
  let protocol: string;
  try {
    protocol = new URL(rawUrl).protocol;
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${rawUrl}`, rawUrl, { kind: 'invalid-url' });
  }
  if (protocol !== 'https:') {
    throw new SsrfBlockedError(
      `Blocked: credentialed request requires https (got ${protocol})`,
      rawUrl,
      { kind: 'invalid-protocol' },
    );
  }
  return validateUrl(rawUrl, []);
}

// ============================================================================
// Fetching the address that was actually validated
// ============================================================================

/**
 * Validate a URL and then fetch the address that validation approved.
 *
 * Validating a hostname and then fetching that hostname are two separate
 * resolutions, and they do not have to agree. `resolveAndValidateHost` resolves
 * with `family: 4`, so it range-checks the A record — while Node's default
 * dual-stack lookup prefers AAAA. A name publishing a public A record and
 * `AAAA ::1` therefore passes the guard and connects to loopback. That is the
 * ordinary path for a dual-stack name, not a corner case.
 *
 * Over http the connection is pinned to the validated address and the original
 * host travels in the `Host` header, so name resolution cannot be revisited
 * between the check and the connect.
 *
 * Over https the request goes by name on purpose: pinning would present a
 * certificate that does not match, and TLS server-certificate validation is
 * itself what defeats a rebind — a redirected connection cannot produce a valid
 * certificate for the requested host.
 */
export type SafeFetchInit = Omit<RequestInit, 'redirect'> & {
  allowedHosts?: readonly string[];
  /**
   * `'follow'` is absent by construction. A followed redirect is a second
   * request, to a host nothing validated, issued inside `fetch` where this
   * function cannot see it — so the guard would cover only the first hop. A
   * caller that needs to follow one must take `'manual'` and re-enter here with
   * the new URL, which puts the next hop through the same checks.
   */
  redirect?: 'error' | 'manual';
};

export async function safeFetch(
  rawUrl: string | URL,
  options: SafeFetchInit = {},
): Promise<Response> {
  const { allowedHosts = [], redirect = 'error', ...init } = options;
  const validated = await validateUrl(rawUrl.toString(), [...allowedHosts]);

  if (validated.url.protocol === 'https:') {
    return fetch(validated.url.toString(), { ...init, redirect });
  }

  const pinned = new URL(validated.url.toString());
  const headers = new Headers(init.headers);
  headers.set('Host', pinned.host);
  pinned.hostname = validated.resolvedHost.ip;

  return fetch(pinned.toString(), { ...init, headers, redirect });
}

/**
 * `safeFetch` in the shape of `fetch`, for the injection points that type their
 * transport as `typeof fetch`. A `Request` carries its own URL past the checks
 * above, so it is refused rather than quietly unwrapped.
 */
export const safeFetchImpl: typeof fetch = (input, init) => {
  if (input instanceof Request) {
    return Promise.reject(
      new SsrfBlockedError('Blocked: a Request object bypasses URL validation', input.url, {
        kind: 'invalid-url',
      }),
    );
  }
  // `typeof fetch` admits `'follow'`, so the compile-time exclusion on
  // SafeFetchInit cannot reach this boundary — the injected-transport callers
  // are exactly the ones that would otherwise reintroduce unchecked hops.
  if (init?.redirect === 'follow') {
    return Promise.reject(
      new SsrfBlockedError(
        'Blocked: following redirects would leave the next hop unvalidated',
        String(input),
        { kind: 'invalid-url' },
      ),
    );
  }
  const { redirect, ...rest } = init ?? {};
  return safeFetch(input, { ...rest, ...(redirect === 'manual' ? { redirect } : {}) });
};

// ============================================================================
// Method Restriction
// ============================================================================

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isMethodAllowed(method: string, allowedMethods: string[]): boolean {
  return allowedMethods.includes(method.toUpperCase());
}

export function isIdempotentMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase()) || method.toUpperCase() === 'PUT';
}

// ============================================================================
// Redirect Safety
// ============================================================================

export function isRedirectSafe(
  originalHost: string,
  redirectUrl: string,
  allowCrossHost: boolean,
): boolean {
  try {
    const parsed = new URL(redirectUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    if (!allowCrossHost && parsed.hostname !== originalHost) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Why a URL was blocked. Distinguishes operator-fixable cases
 * (`'allowlist-host'` — egress policy too tight, can be widened via
 * bind-capability) from hard platform-security blocks (`'private-ip'`,
 * `'invalid-protocol'`, `'invalid-url'` — never fixable by an agent).
 *
 * The error-handling layer reads this to choose between
 * `API_BINDING_EGRESS_BLOCKED` (actionable, suggests bind-capability) and
 * `API_SSRF_BLOCKED` (terminal, agent should signal_blocked).
 */
export type SsrfBlockKind =
  'allowlist-host' | 'private-ip' | 'invalid-protocol' | 'invalid-url' | 'unresolvable';

export class SsrfBlockedError extends Error {
  readonly code = 'API_SSRF_BLOCKED' as const;
  readonly kind: SsrfBlockKind;
  readonly target: string;
  readonly rangeLabel?: string;

  constructor(
    message: string,
    target: string,
    options?: { kind?: SsrfBlockKind; rangeLabel?: string },
  ) {
    super(message);
    this.name = 'SsrfBlockedError';
    this.kind = options?.kind ?? 'private-ip';
    this.target = target;
    if (options?.rangeLabel !== undefined) {
      this.rangeLabel = options.rangeLabel;
    }
  }
}

export class DnsBlockedError extends Error {
  readonly code = 'API_DNS_BLOCKED' as const;
  readonly hostname: string;

  constructor(message: string, hostname: string) {
    super(message);
    this.name = 'DnsBlockedError';
    this.hostname = hostname;
  }
}
