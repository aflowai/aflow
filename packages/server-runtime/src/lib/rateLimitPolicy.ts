// ============================================================================
// Limits per class
// ============================================================================

import { createHash } from 'node:crypto';
import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import type { FastifyRequest } from 'fastify';

/**
 * Budgets are split by trust, not by endpoint. An authenticated caller has
 * proven who they are and can be held to account; an anonymous one cannot, so
 * it gets only what the pre-login surface actually needs. Giving both the same
 * allowance — which is what a single pair of numbers does — means the cheapest
 * possible attacker is funded like a paying customer.
 *
 * Authenticated numbers leave room for a dashboard opening several panels at
 * once; the point of the limit is to stop a runaway client, not to pace a
 * normal one.
 */
export const RATE_LIMIT_READS_PER_MIN = 600;
export const RATE_LIMIT_MUTATIONS_PER_MIN = 120;

/**
 * Login, the OAuth callbacks and health are already exempt, so what remains
 * unauthenticated is mostly probing. Kept low deliberately: a real user
 * crosses into the authenticated tier within a request or two of arriving.
 */
export const RATE_LIMIT_ANONYMOUS_READS_PER_MIN = 60;
export const RATE_LIMIT_ANONYMOUS_MUTATIONS_PER_MIN = 20;

export const RATE_LIMIT_WINDOW_MS = 60_000;

export const RATE_LIMIT_SIGNUPS_PER_HOUR = 10;
export const SIGNUP_RATE_LIMIT_WINDOW_MS = 3_600_000;

export const RATE_LIMIT_INVITE_REQUESTS_PER_HOUR = 10;
export const INVITE_REQUEST_RATE_LIMIT_WINDOW_MS = 3_600_000;
export const RATE_LIMIT_INVITE_REQUESTS_PER_EMAIL_PER_DAY = 5;
export const INVITE_REQUEST_EMAIL_RATE_LIMIT_WINDOW_MS = 86_400_000;

// ============================================================================
// Method discriminator
// ============================================================================

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutationMethod(method: string): boolean {
  return MUTATION_METHODS.has(method.toUpperCase());
}

// ============================================================================
// Bypass policy — endpoints exempted from rate-limit entirely
// ============================================================================

export function shouldBypassRateLimit(url: string): boolean {
  // Strip query string so /url?foo=bar matches /url patterns.
  const path = url.split('?')[0] ?? url;

  // --- Health checks ---
  // The limiter is Redis-backed, so a probe that runs through it fails with an
  // error from the very dependency it exists to report on — a readiness check
  // answering 500 rather than 503 when Redis is down has it exactly backwards.
  if (path === '/health' || path === '/ready' || path === '/live') return true;
  if (path.startsWith('/v1/health/')) return true;

  // --- Auth / OAuth flow ---
  // Login redirects, OAuth callbacks; user is not authenticated yet,
  // and gating these encourages tenant-limit spillover at the worst
  // possible moment (mid-login).
  if (path.startsWith('/v1/auth/')) return true;
  if (path.startsWith('/v1/oauth/')) return true;

  // --- Streams: SSE + WebSocket ---
  // Long-lived connections; counting them in req/min is the wrong
  // shape. Follow-up: concurrent-connection cap per user.
  if (path === '/v1/realtime') return true; // WebSocket
  // Minted once per connection attempt, so it tracks reconnects rather than
  // user intent — a flapping network would spend the caller's whole mutation
  // budget on handshakes and take the rest of the app down with it. The right
  // bound here is concurrent connections, not requests per minute.
  if (path === '/v1/realtime/token') return true;
  if (path.startsWith('/v1/agui/')) return true; // AG-UI streaming sessions

  return false;
}

// ============================================================================
// Key generator — segments counters by user + method-class
// ============================================================================

/**
 * Produce the rate-limit bucket key for a request. Two-axis split:
 *
 *   1. Caller identity, derived from the credential rather than the
 *      resolved user. The limiter runs in `onRequest`, which is before
 *      the route `preHandler` that populates `request.authUser` — so a
 *      key built from `authUser` is always the unauthenticated fallback,
 *      and every caller behind one proxy shares a bucket. Hashing the
 *      bearer credential separates callers at the only point where
 *      anything identifying is available, with no lookup.
 *
 *      The hash is truncated because the key only has to distinguish
 *      callers, and a full-length digest of a live credential is not
 *      something to write into logs or store keys.
 *
 *   2. Method class. Reads and mutations get separate buckets so a
 *      spike of cached GETs doesn't consume the operator's mutation
 *      budget. Combined with `rateLimitMaxForMethod` below, this
 *      means a caller can issue ~300 GETs/min AND ~60 mutations/min
 *      independently.
 */
export function rateLimitKey(opts: {
  authorization: string | undefined;
  ip: string;
  method: string;
}): string {
  const klass = isMutationMethod(opts.method) ? 'mutations' : 'reads';
  const credential = opts.authorization?.trim();
  const id = credential
    ? `cred:${createHash('sha256').update(credential).digest('hex').slice(0, 32)}`
    : `ip:${opts.ip}`;
  return `${klass}:${id}`;
}

// ============================================================================
// Max-per-window per method class
// ============================================================================

/**
 * The `max` count for the bucket the given method maps to. Mutations
 * get the stricter limit; everything else falls under reads.
 *
 * @fastify/rate-limit accepts `max` as a function; this is the
 * value to return from there.
 */
export function rateLimitMaxForMethod(method: string, authenticated: boolean): number {
  if (authenticated) {
    return isMutationMethod(method) ? RATE_LIMIT_MUTATIONS_PER_MIN : RATE_LIMIT_READS_PER_MIN;
  }
  return isMutationMethod(method)
    ? RATE_LIMIT_ANONYMOUS_MUTATIONS_PER_MIN
    : RATE_LIMIT_ANONYMOUS_READS_PER_MIN;
}

/**
 * Whether a request presents a credential at all. Deliberately not "is the
 * credential valid" — this runs before authentication, and the question here
 * is only which budget applies. An invalid credential still buys the
 * authenticated tier, but only for the one bucket its own hash names, so a
 * forged header wins nothing beyond a bucket nobody else uses.
 */
export function isAuthenticatedRequest(authorization: string | undefined): boolean {
  return Boolean(authorization?.trim());
}

// ============================================================================
// Signup class — new-user JIT provisioning, per-IP
// ============================================================================

export function signupRateLimitKey(ip: string): string {
  return `aflow:ratelimit:signup:${ip}`;
}

/** Structural subset of ioredis so the policy module stays dependency-free. */
export interface FixedWindowStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number, mode: 'NX'): Promise<unknown>;
}

/**
 * Fixed-window counter shared by the pre-auth abuse classes. `EXPIRE NX` on
 * every attempt heals a window key that lost its TTL to a crash mid-consume.
 */
async function consumeFixedWindow(
  store: FixedWindowStore,
  key: string,
  windowMs: number,
  max: number,
): Promise<boolean> {
  const count = await store.incr(key);
  await store.expire(key, windowMs / 1000, 'NX');
  return count <= max;
}

/**
 * Per-IP counter for signup completion. Enforced at the JIT provisioning call
 * site inside the auth hook — new-user creation happens during authentication
 * of the first request, so it never maps to a URL the route-level
 * @fastify/rate-limit plugin could class.
 */
export async function consumeSignupRateLimit(
  store: FixedWindowStore,
  ip: string,
): Promise<boolean> {
  return consumeFixedWindow(
    store,
    signupRateLimitKey(ip),
    SIGNUP_RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_SIGNUPS_PER_HOUR,
  );
}

// ============================================================================
// Invite-request class — public request-access funnel, per-IP AND per-email
// ============================================================================

export function inviteRequestIpRateLimitKey(ip: string): string {
  return `aflow:ratelimit:invite-request:ip:${ip}`;
}

/** Email is hashed so the address never appears in Redis keys. */
export function inviteRequestEmailRateLimitKey(email: string): string {
  const digest = createHash('sha256').update(email).digest('hex').slice(0, 32);
  return `aflow:ratelimit:invite-request:email:${digest}`;
}

export type InviteRequestRateLimitOutcome = 'allowed' | 'ip_limited' | 'email_limited';

/**
 * Both windows are consumed on every attempt (even one that will be rejected
 * or silently collapsed) — attempts, not successes, are the abuse signal.
 *
 * The outcome distinguishes which window blocked because the caller must NOT
 * surface email exhaustion: the per-email counter is shared across all IPs, so
 * a visible rejection would leak that third parties recently submitted the
 * address. Only `ip_limited` (the caller's own budget) may answer 429.
 */
export async function consumeInviteRequestRateLimit(
  store: FixedWindowStore,
  ip: string,
  email: string,
): Promise<InviteRequestRateLimitOutcome> {
  const ipOk = await consumeFixedWindow(
    store,
    inviteRequestIpRateLimitKey(ip),
    INVITE_REQUEST_RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_INVITE_REQUESTS_PER_HOUR,
  );
  const emailOk = await consumeFixedWindow(
    store,
    inviteRequestEmailRateLimitKey(email),
    INVITE_REQUEST_EMAIL_RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_INVITE_REQUESTS_PER_EMAIL_PER_DAY,
  );
  if (!ipOk) return 'ip_limited';
  if (!emailOk) return 'email_limited';
  return 'allowed';
}

// ============================================================================
// Plugin wiring
// ============================================================================

/**
 * Every field the limiter plugin is registered with, in one place so the
 * object under test is the object that runs. A copy assembled separately in a
 * test proves only that the copy is correct.
 *
 * `redis` is the caller's to supply: it is a live connection, which a policy
 * module has no business opening.
 */
export function buildRateLimitOptions(opts: {
  redis?: unknown;
  clientIp: (req: FastifyRequest) => string;
}): RateLimitPluginOptions {
  return {
    // Counters live in Redis so the limit means one thing across instances.
    // In memory it is per-process, so the real ceiling is the configured
    // number times however many instances happen to be running, and it resets
    // whenever one recycles — a limit that cannot be reasoned about.
    //
    // A dedicated connection with the offline queue disabled: if Redis goes
    // away, commands must fail immediately so the limiter degrades to
    // allowing traffic. Queued commands would instead stall every request on
    // the way in, turning a limiter outage into an API outage.
    ...(opts.redis ? { redis: opts.redis } : {}),
    // Failing fast is only half of degrading to allow: the plugin rethrows a
    // store error onto the request unless told otherwise, so without this the
    // disabled offline queue converts a Redis blip into a 500 on every route
    // it guards — the API outage the line above exists to prevent.
    skipOnError: true,
    nameSpace: 'aflow:ratelimit:',
    // Per-method and per-trust-tier: an anonymous caller gets a fraction of
    // an authenticated one's budget.
    max: (req) =>
      rateLimitMaxForMethod(req.method, isAuthenticatedRequest(req.headers.authorization)),
    timeWindow: RATE_LIMIT_WINDOW_MS,
    // Keyed on the credential, not the resolved user: this hook runs
    // before authentication, so `req.authUser` is not populated yet.
    keyGenerator: (req) =>
      rateLimitKey({
        authorization: req.headers.authorization,
        ip: opts.clientIp(req),
        method: req.method,
      }),
    // Streams + health + auth bypass entirely.
    allowList: (req) => shouldBypassRateLimit(req.url),
  };
}
