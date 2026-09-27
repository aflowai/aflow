/**
 * What makes a request to the local appliance's BFF trustworthy.
 *
 * The BFF attaches the owner's instance secret to whatever reaches it, so
 * "reachable" is the whole authorization decision — and that only holds where
 * reaching this process already means standing on the operator's own host:
 *
 * - **Loopback only.** A routable name proves nothing about who arrived: any
 *   browser on the network resolves it, an ordinary navigation carries no
 *   `Origin` to compare, and the BFF would hand that caller the owner's
 *   credential. TLS in front of such a name protects the wire without naming
 *   the caller, so publishing the appliance is an authentication problem
 *   rather than a host-list one. `PHOENIX_ALLOWED_HOSTS` may narrow the
 *   loopback names this instance answers to and cannot add another.
 * - **DNS rebinding.** A page on `attacker.example` served with a one-second
 *   TTL that re-resolves to `127.0.0.1` becomes same-origin with this process,
 *   and `next start` performs no host check of its own. The `Host` header is
 *   what still names the attacker.
 * - **Cross-origin CSRF.** A simple request — no custom headers, no
 *   preflight — reaches body-less state changers on the API. The `Origin`
 *   header is what still names the attacker, and it is compared as a whole
 *   origin — scheme, host and port — against the origin this request arrived
 *   on: another service on the same host, one port over, is not this one, and
 *   neither is a page served over cleartext on the same name.
 *
 * All three are refused here, on the same shape the MCP server already uses
 * for its host gate. `Host` names where the browser believes it arrived rather
 * than the interface it came in on, so the loopback rule rests on the
 * appliance binding loopback: a process published on `0.0.0.0` accepts
 * `Host: localhost` from anyone who can route to it.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * The loopback names this instance answers to.
 *
 * A configured list may only narrow them. An entry naming anything else is
 * dropped rather than honoured, and a list that ends up naming nothing leaves
 * the loopback default in place — the alternative is an appliance that answers
 * nowhere at all because its configuration asked for the one thing this guard
 * cannot grant.
 */
function allowedHosts(env: NodeJS.ProcessEnv): Set<string> {
  const configured = env['PHOENIX_ALLOWED_HOSTS']
    ?.split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => LOOPBACK_HOSTS.has(host));
  return configured && configured.length > 0 ? new Set(configured) : LOOPBACK_HOSTS;
}

/** Strip the port; a host is trusted by name, whichever port it was published on. */
function hostname(value: string): string {
  const lowered = value.trim().toLowerCase();
  if (lowered.startsWith('[')) return lowered.slice(0, lowered.indexOf(']') + 1);
  return lowered.replace(/:\d+$/, '');
}

/** Names both what the appliance requires and why the host list is not it. */
function routableHostRefusal(host: string): string {
  return (
    `Host ${host} is not loopback, and arriving at a routable name is not proof of ownership: ` +
    `the BFF attaches the appliance owner's instance secret to every request it accepts. ` +
    `This instance answers on loopback only (${[...LOOPBACK_HOSTS].join(', ')}); access from ` +
    'another machine belongs on a port forwarded to one of them. Reaching it over a LAN or the ' +
    'internet requires a boundary in front of this process that authenticates the operator; ' +
    'PHOENIX_ALLOWED_HOSTS is not one, and cannot grant a routable host.'
  );
}

/**
 * The scheme the browser used, which is not the one this process was reached
 * on whenever a TLS terminator sits in front of it — there the request arrives
 * as plain HTTP and only `X-Forwarded-Proto` still names what the browser saw.
 *
 * Honouring the header where nothing sets it can only tighten the comparison:
 * a forged `https` makes this process demand HTTPS origins, which refuses the
 * cleartext page that forged it.
 */
function effectiveScheme(forwardedProto: string | null, urlProtocol: string): string {
  const forwarded = forwardedProto?.split(',')[0]?.trim();
  const declared = forwarded !== undefined && forwarded !== '' ? forwarded : urlProtocol;
  return declared.trim().toLowerCase().replace(/:$/, '');
}

export interface LocalRequest {
  /** `Host`. */
  host: string | null;
  /** `Origin`. */
  origin: string | null;
  /** `X-Forwarded-Proto`, when a terminator in front of this process sets it. */
  forwardedProto: string | null;
  /** The protocol this process itself received the request on, e.g. `http:`. */
  urlProtocol: string;
}

/**
 * Why the request was refused, or `null` when it is acceptable.
 *
 * A missing `Origin` is allowed: the browser omits it on same-origin GETs and
 * on ordinary navigation, and requiring it would refuse the operator's own
 * first page load. That allowance is the reason the loopback rule below cannot
 * be traded for a host list — an absent `Origin` names nobody, so the host is
 * all that is left to place the caller.
 */
export function refuseLocalRequest({
  host,
  origin,
  forwardedProto,
  urlProtocol,
}: LocalRequest): string | null {
  if (host === null || host.trim() === '') {
    return 'Request carries no Host header.';
  }

  const name = hostname(host);
  if (!LOOPBACK_HOSTS.has(name)) {
    return routableHostRefusal(host);
  }
  if (!allowedHosts(process.env).has(name)) {
    return `Host ${host} is not one this instance answers to; PHOENIX_ALLOWED_HOSTS names the loopback hosts it does.`;
  }

  const scheme = effectiveScheme(forwardedProto, urlProtocol);
  if (scheme !== 'http' && scheme !== 'https') {
    return `Request arrived on ${scheme}, which is not an HTTP scheme.`;
  }

  // The origin this request itself arrived on, which is what an acceptable
  // `Origin` has to be. Both sides are canonicalized by `URL`, so a default
  // port written out — `https://host:443` — is the same origin as one that
  // leaves it off.
  let expected: URL;
  try {
    expected = new URL(`${scheme}://${host.trim()}`);
  } catch {
    return `Host ${host} is not a host this instance can be reached at.`;
  }

  if (origin !== null && origin.trim() !== '') {
    // An opaque origin — a sandboxed iframe, a `file://` page, some
    // cross-origin redirects — names nothing that can be checked, so it cannot
    // be the operator's own page and is refused rather than waved through.
    if (origin === 'null') {
      return 'Request carries an opaque Origin.';
    }

    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return `Origin ${origin} is not a URL.`;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Origin ${origin} is not an HTTP origin.`;
    }
    // Compared whole, scheme included: a page served over cleartext on this
    // very hostname is a different origin, and comparing authorities alone
    // would let it drive the BFF from outside the TLS the deployment requires.
    if (parsed.origin !== expected.origin) {
      return `Origin ${origin} is not this instance.`;
    }
  }

  return null;
}
