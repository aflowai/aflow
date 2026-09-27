/**
 * Client-IP derivation behind the Cloudflare-proxied topology. The server
 * terminates connections from the proxy, so `request.ip` is the proxy — an
 * IP-keyed limiter would share one bucket across all real clients. Only
 * requests that prove they came through trusted infrastructure
 * (`X-Origin-Verify` matches `CF_ORIGIN_SECRET`; the secret is held by the
 * web BFF and MCP server, never injected by Cloudflare) get header-derived
 * IPs:
 *
 *   - `X-Client-IP` — set by the web BFF, which terminates the browser
 *     connection itself. For BFF traffic `CF-Connecting-IP` is the BFF's
 *     egress IP, so without this header every browser user would share one
 *     rate-limit bucket.
 *   - `CF-Connecting-IP` — the real client IP as seen by Cloudflare, for
 *     trusted callers that don't front their own clients.
 *
 * Bare `X-Forwarded-For` is spoofable and never consulted.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

interface ClientIpRequest {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}

function secretMatches(provided: string, secret: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

export function clientIp(request: ClientIpRequest): string {
  const secret = process.env['CF_ORIGIN_SECRET'];
  const provided = request.headers['x-origin-verify'];
  if (secret && typeof provided === 'string' && secretMatches(provided, secret)) {
    const forwardedIp = request.headers['x-client-ip'];
    if (typeof forwardedIp === 'string' && forwardedIp.length > 0) {
      return forwardedIp;
    }
    const cfIp = request.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.length > 0) {
      return cfIp;
    }
  }
  return request.ip;
}
