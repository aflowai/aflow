/**
 * Which requests this server answers, decided before any session is created or read.
 *
 * A session that brings no credential is given the owner's key from the local
 * auth file, and a web page can reach a loopback listener under a name of its
 * own by rebinding that name to 127.0.0.1. To the browser that is same-origin,
 * so CORS never applies and loopback binding does not help: the Host header is
 * what still carries the page's name, and Origin is what says a browser sent it.
 */
import type { McpServerConfig } from './config.js';

const LOOPBACK_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];
const DEFAULT_HTTP_PORT = 80;

export interface RequestGatePolicy {
  /** `ALLOWED_HOSTS`, matched by hostname on any port. Empty: loopback names on `port` only. */
  readonly allowedHosts: readonly string[];
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly holdsOwnerKey: boolean;
}

export function requestGatePolicy(
  config: Pick<
    McpServerConfig,
    'allowedHosts' | 'port' | 'allowBrowserOrigins' | 'allowedOrigins' | 'localAuthJsonPath'
  >,
): RequestGatePolicy {
  // A configured path counts whether or not the file parses yet: it is read
  // again for every new session, so it can start handing out the key at any time.
  const holdsOwnerKey = config.localAuthJsonPath !== undefined;
  return {
    allowedHosts: config.allowedHosts,
    port: config.port,
    allowedOrigins: holdsOwnerKey || !config.allowBrowserOrigins ? [] : config.allowedOrigins,
    holdsOwnerKey,
  };
}

declare const admittedBrand: unique symbol;

/** Headers that passed {@link admitRequest}: the only ones a session's credential is chosen from. */
export type AdmittedHeaders = Readonly<Record<string, string | undefined>> & {
  readonly [admittedBrand]: true;
};

export type GateDecision =
  | {
      readonly admitted: true;
      readonly headers: AdmittedHeaders;
      /** The Host header exactly as sent, for the transport's own check. */
      readonly host: string;
      readonly origin: string | undefined;
    }
  | { readonly admitted: false; readonly status: 421 | 403; readonly reason: string };

function parseHost(value: string): { hostname: string; port: number | undefined } | undefined {
  const match = /^(\[[0-9a-f:.]+\]|[^\s:[\]/@]+)(?::(\d{1,5}))?$/i.exec(value);
  const hostname = match?.[1];
  if (hostname === undefined) return undefined;
  const port = match?.[2];
  return { hostname: hostname.toLowerCase(), port: port === undefined ? undefined : Number(port) };
}

function answersTo(policy: RequestGatePolicy, host: string): boolean {
  const parsed = parseHost(host);
  if (parsed === undefined) return false;
  if (policy.allowedHosts.length > 0) return policy.allowedHosts.includes(parsed.hostname);
  return (
    LOOPBACK_HOSTNAMES.includes(parsed.hostname) &&
    (parsed.port ?? DEFAULT_HTTP_PORT) === policy.port
  );
}

/** `headers` keyed in lower case, one value each. */
export function admitRequest(
  policy: RequestGatePolicy,
  headers: Readonly<Record<string, string | undefined>>,
): GateDecision {
  const host = headers['host'];
  if (host === undefined || host === '') {
    return {
      admitted: false,
      status: 421,
      reason: 'Refused: the request names no Host, and this server answers only to its own.',
    };
  }
  if (!answersTo(policy, host)) {
    return {
      admitted: false,
      status: 421,
      reason: `Refused: this server does not answer to the Host ${host}.`,
    };
  }

  const origin = headers['origin'];
  if (origin !== undefined && !policy.allowedOrigins.includes(origin.toLowerCase())) {
    return {
      admitted: false,
      status: 403,
      reason: policy.holdsOwnerKey
        ? `Refused: no browser origin may use this server while it holds the owner's key, and this request came from ${origin}.`
        : `Refused: the browser origin ${origin} is not one this server allows.`,
    };
  }

  return { admitted: true, headers: headers as AdmittedHeaders, host, origin };
}

/**
 * The SDK transport's own rebinding check, pinned to the Host the session was
 * admitted under: every later request on the session must name the same one.
 */
export function transportRebindingOptions(
  policy: RequestGatePolicy,
  admittedHost: string,
): { enableDnsRebindingProtection: true; allowedHosts: string[]; allowedOrigins: string[] } {
  return {
    enableDnsRebindingProtection: true,
    allowedHosts: [admittedHost],
    allowedOrigins: [...policy.allowedOrigins],
  };
}
