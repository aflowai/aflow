import { DEFAULT_API_PORT } from '@aflow/lib';

const DEFAULT_PORT = String(DEFAULT_API_PORT);

/**
 * The single form of a configured origin, or `null` when the value is not an
 * absolute http(s) URL: scheme and host folded to lower case, a default port
 * dropped, and path, query, fragment and credentials removed.
 *
 * Consumers append a fixed path to the resolved origin and the realtime route
 * exchanges its scheme, so a value that merely looks like an origin —
 * `HTTPS://api.aflow.ai`, `https://api.aflow.ai?x=1`, a stray surrounding
 * space — builds a URL that addresses something else. Reducing to the origin
 * here is what lets the startup check judge the exact string those consumers
 * receive, rather than a raw value that only resembles it.
 */
export function canonicalApiOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin;
}

function loopbackOrigin(): string {
  const port = process.env['PORT'];
  const fallback = `http://localhost:${DEFAULT_PORT}`;
  if (port === undefined) return fallback;
  return canonicalApiOrigin(`http://localhost:${port}`) ?? fallback;
}

/**
 * The canonical origin this API is reachable at, e.g. `https://api.aflow.ai`.
 *
 * Never derived from the request. `Host` is caller-controlled, and so is
 * Fastify's `request.hostname`, which prefers `X-Forwarded-Host` behind a
 * proxy — a link built from either can be aimed at an attacker's origin and
 * then handed back to the client as a URL the platform issued. The loopback
 * fallback exists so local dev works without configuration; every deployed
 * environment sets `API_BASE_URL`, and OAuth already depends on it there.
 *
 * A configured value that is not a URL at all falls back to loopback too — a
 * deployed process never reaches that branch, because the startup security
 * check refuses to boot on it.
 */
export function resolveApiBaseUrl(): string {
  const configured = process.env['API_BASE_URL'];
  const canonical = configured === undefined ? null : canonicalApiOrigin(configured);
  return canonical ?? loopbackOrigin();
}

/**
 * The same origin addressed as a WebSocket, e.g. `wss://api.aflow.ai`.
 *
 * The scheme is exchanged through the URL parser: a textual `http` → `ws`
 * rewrite matches only a lower-case scheme, and where it fails to match it
 * yields a URL no browser opens as a socket rather than an error anything can
 * report.
 */
export function resolveWebSocketOrigin(): string {
  const url = new URL(resolveApiBaseUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.origin;
}
