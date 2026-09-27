/**
 * The security posture every application that serves this product must send.
 *
 * Headers are per-application configuration in Next, so each one used to write
 * its own set — and they diverged completely: the hosted application sent six,
 * and the local application sent none. That is invisible until something serves
 * the local one, at which point a content policy, frame denial, MIME sniffing
 * refusal and referrer policy all disappear at once with nothing failing.
 *
 * Assembled from stated inputs rather than read from the environment, because
 * which origins a distribution talks to is the distribution's answer and a
 * package guessing it is how a policy comes out well-formed and wrong.
 */

/** Where a distribution's own traffic goes, and what it tolerates. */
export interface SecurityPolicyInput {
  /**
   * The API's origin, as a browser would write it. `connect-src` omits the API
   * entirely when this is empty, which a report-only policy tolerates and an
   * enforced one does not — it severs every direct call and the realtime socket.
   */
  apiOrigin?: string | undefined;

  /**
   * Where the realtime gateway answers, as the server will mint it — the same
   * `API_BASE_URL` its token route derives `realtimeUrl` from. Stated because a
   * distribution that proxies its API through its own origin tells the browser
   * nothing about the API and still hands it an absolute socket URL, so
   * `connect-src 'self'` covers every call it makes except the one that matters.
   * Given as an `http(s)` origin its scheme is exchanged; a `ws(s)` one is used
   * as it stands.
   */
  realtimeOrigin?: string | undefined;

  /** Where violation reports go, if anywhere. */
  reportUri?: string | undefined;

  /** Enforce, rather than report. */
  enforce: boolean;

  /**
   * Extra sources a distribution's own surfaces need, per directive. The hosted
   * login and admission pages need a challenge provider; a local instance has
   * nobody to challenge.
   */
  additionalSources?:
    | Readonly<Partial<Record<'script-src' | 'frame-src' | 'connect-src', readonly string[]>>>
    | undefined;
}

export interface HttpHeader {
  key: string;
  value: string;
}

/**
 * An origin addressed as a WebSocket.
 *
 * The realtime gateway is a socket, and the browser is handed its URL by the
 * server (`/v1/realtime/token` returns `realtimeUrl`), so no client-side setting
 * can steer it to an already-allowed origin. CSP matches schemes exactly — an
 * `https:` source does not authorize a `wss:` connection — so the socket needs
 * its own source built from the same origin.
 */
function webSocketOrigin(origin: string): string {
  return origin.replace(/^http/, 'ws');
}

/** One source per origin: two configurations naming the same host are one. */
function dedupe(sources: readonly string[]): string[] {
  return [...new Set(sources.filter(Boolean))];
}

export function contentSecurityPolicy(input: SecurityPolicyInput): string {
  const apiOrigin = input.apiOrigin ?? '';
  const extra = (directive: 'script-src' | 'frame-src' | 'connect-src'): string =>
    (input.additionalSources?.[directive] ?? []).map((source) => ` ${source}`).join('');

  const connectSrc = dedupe([
    "'self'",
    'https://*.sentry.io',
    apiOrigin,
    webSocketOrigin(apiOrigin),
    webSocketOrigin(input.realtimeOrigin ?? ''),
    ...(input.additionalSources?.['connect-src'] ?? []),
  ]);

  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval'${extra('script-src')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    // The SVG injection sink: no plugin documents, no nested browsing contexts,
    // and no way to re-point relative URLs.
    "object-src 'none'",
    `frame-src 'self'${extra('frame-src')}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(input.reportUri !== undefined && input.reportUri !== ''
      ? [`report-uri ${input.reportUri}`]
      : []),
  ].join('; ');
}

/** Every header an application serving this product sends on every response. */
export function securityHeaders(input: SecurityPolicyInput): HttpHeader[] {
  return [
    {
      key: input.enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
      value: contentSecurityPolicy(input),
    },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
    // Opt in to the browser's JS self-profiling API so browser profiling can
    // collect profiles.
    { key: 'Document-Policy', value: 'js-profiling' },
  ];
}
