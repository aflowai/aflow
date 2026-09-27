import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildRateLimitOptions,
  RATE_LIMIT_INVITE_REQUESTS_PER_EMAIL_PER_DAY,
  RATE_LIMIT_INVITE_REQUESTS_PER_HOUR,
  RATE_LIMIT_MUTATIONS_PER_MIN,
  RATE_LIMIT_ANONYMOUS_READS_PER_MIN,
  RATE_LIMIT_ANONYMOUS_MUTATIONS_PER_MIN,
  isAuthenticatedRequest,
  RATE_LIMIT_READS_PER_MIN,
  RATE_LIMIT_SIGNUPS_PER_HOUR,
  RATE_LIMIT_WINDOW_MS,
  SIGNUP_RATE_LIMIT_WINDOW_MS,
  consumeInviteRequestRateLimit,
  consumeSignupRateLimit,
  inviteRequestEmailRateLimitKey,
  isMutationMethod,
  rateLimitKey,
  rateLimitMaxForMethod,
  shouldBypassRateLimit,
  signupRateLimitKey,
  type FixedWindowStore,
} from './rateLimitPolicy.js';

// ============================================================================
// Method discriminator
// ============================================================================

describe('isMutationMethod', () => {
  it('treats POST / PUT / PATCH / DELETE as mutations', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isMutationMethod(m)).toBe(true);
    }
  });

  it('treats GET / HEAD / OPTIONS as non-mutations', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      expect(isMutationMethod(m)).toBe(false);
    }
  });

  it('is case-insensitive', () => {
    expect(isMutationMethod('post')).toBe(true);
    expect(isMutationMethod('Get')).toBe(false);
  });
});

// ============================================================================
// Limits per class
// ============================================================================

describe('rateLimitMaxForMethod', () => {
  it('returns the mutation cap for POST / PUT / PATCH / DELETE', () => {
    expect(rateLimitMaxForMethod('POST', true)).toBe(RATE_LIMIT_MUTATIONS_PER_MIN);
    expect(rateLimitMaxForMethod('DELETE', true)).toBe(RATE_LIMIT_MUTATIONS_PER_MIN);
  });

  it('returns the reads cap for GET', () => {
    expect(rateLimitMaxForMethod('GET', true)).toBe(RATE_LIMIT_READS_PER_MIN);
  });

  it('reads cap is meaningfully larger than mutation cap', () => {
    // Spec test: reads are generous (client cache absorbs duplicates);
    // mutations are intentional acts and stay tighter.
    expect(RATE_LIMIT_READS_PER_MIN).toBeGreaterThan(RATE_LIMIT_MUTATIONS_PER_MIN);
    expect(RATE_LIMIT_ANONYMOUS_READS_PER_MIN).toBeGreaterThan(
      RATE_LIMIT_ANONYMOUS_MUTATIONS_PER_MIN,
    );
  });

  // An unauthenticated caller cannot be held to account, so it must not be
  // funded like one that can. A single pair of numbers gave both the same
  // allowance, which is what made anonymous probing as cheap as real use.
  it('gives an anonymous caller strictly less than an authenticated one', () => {
    expect(rateLimitMaxForMethod('GET', false)).toBeLessThan(rateLimitMaxForMethod('GET', true));
    expect(rateLimitMaxForMethod('POST', false)).toBeLessThan(rateLimitMaxForMethod('POST', true));
  });

  it('applies the anonymous caps when no credential is presented', () => {
    expect(rateLimitMaxForMethod('GET', false)).toBe(RATE_LIMIT_ANONYMOUS_READS_PER_MIN);
    expect(rateLimitMaxForMethod('POST', false)).toBe(RATE_LIMIT_ANONYMOUS_MUTATIONS_PER_MIN);
  });
});

describe('isAuthenticatedRequest', () => {
  it('is true for any presented credential', () => {
    expect(isAuthenticatedRequest('Bearer ey.aaa.sig')).toBe(true);
    expect(isAuthenticatedRequest('Bearer phx_abc')).toBe(true);
  });

  it('is false when absent or blank', () => {
    expect(isAuthenticatedRequest(undefined)).toBe(false);
    expect(isAuthenticatedRequest('')).toBe(false);
    expect(isAuthenticatedRequest('   ')).toBe(false);
  });

  // It asks whether a credential was presented, not whether it is valid —
  // validity is not known this early. A forged header therefore buys the
  // higher tier, but only inside the bucket its own hash names, which no
  // other caller shares.
  it('does not attempt to judge the credential', () => {
    expect(isAuthenticatedRequest('Bearer obviously-not-a-real-token')).toBe(true);
  });
});

// ============================================================================
// Bucket keys — reads vs mutations, credential vs IP fallback
// ============================================================================

describe('rateLimitKey', () => {
  const BEARER_A = 'Bearer eyJhbGciOi.aaa.sig';
  const BEARER_B = 'Bearer eyJhbGciOi.bbb.sig';

  it('separates reads and mutations into independent buckets for the same caller', () => {
    const readKey = rateLimitKey({ authorization: BEARER_A, ip: '10.0.0.1', method: 'GET' });
    const writeKey = rateLimitKey({ authorization: BEARER_A, ip: '10.0.0.1', method: 'POST' });
    expect(readKey).not.toBe(writeKey);
    expect(readKey).toMatch(/^reads:/);
    expect(writeKey).toMatch(/^mutations:/);
  });

  // The reason this keys on the credential at all: the limiter runs in
  // onRequest, before the preHandler that resolves the user, so anything
  // derived from  is always the unauthenticated fallback. Two
  // callers behind one proxy would then share a bucket and starve each other.
  it('gives distinct callers distinct buckets on a shared egress IP', () => {
    const a = rateLimitKey({ authorization: BEARER_A, ip: '203.0.113.1', method: 'GET' });
    const b = rateLimitKey({ authorization: BEARER_B, ip: '203.0.113.1', method: 'GET' });
    expect(a).not.toBe(b);
  });

  it('is stable for one caller across networks', () => {
    const a = rateLimitKey({ authorization: BEARER_A, ip: '10.0.0.1', method: 'GET' });
    const b = rateLimitKey({ authorization: BEARER_A, ip: '10.0.0.2', method: 'GET' });
    expect(a).toBe(b);
  });

  it('falls back to the IP for requests carrying no credential', () => {
    expect(rateLimitKey({ authorization: undefined, ip: '203.0.113.1', method: 'GET' })).toBe(
      'reads:ip:203.0.113.1',
    );
    expect(rateLimitKey({ authorization: '   ', ip: '203.0.113.1', method: 'GET' })).toBe(
      'reads:ip:203.0.113.1',
    );
  });

  it('never puts the credential itself in the key', () => {
    const key = rateLimitKey({ authorization: BEARER_A, ip: '10.0.0.1', method: 'GET' });
    expect(key).not.toContain('eyJhbGciOi');
    expect(key).not.toContain(BEARER_A);
    expect(key).toMatch(/^reads:cred:[0-9a-f]{32}$/);
  });

  it('distinguishes an API key from a session token', () => {
    const jwt = rateLimitKey({ authorization: BEARER_A, ip: '10.0.0.1', method: 'POST' });
    const apiKey = rateLimitKey({
      authorization: 'Bearer phx_abc123',
      ip: '10.0.0.1',
      method: 'POST',
    });
    expect(jwt).not.toBe(apiKey);
  });
});

// ============================================================================
// Bypass — streams, health, auth
// ============================================================================

describe('shouldBypassRateLimit', () => {
  it('bypasses /health and /v1/health/*', () => {
    expect(shouldBypassRateLimit('/health')).toBe(true);
    expect(shouldBypassRateLimit('/v1/health/engine')).toBe(true);
  });

  it('bypasses the auth flow (/v1/auth/*, /v1/oauth/*)', () => {
    expect(shouldBypassRateLimit('/v1/auth/login')).toBe(true);
    expect(shouldBypassRateLimit('/v1/oauth/callback?code=xyz')).toBe(true);
  });

  it('bypasses WebSocket and spec SSE stream endpoints', () => {
    expect(shouldBypassRateLimit('/v1/realtime')).toBe(true);
    // Minted once per connection attempt, so it counts reconnects rather than
    // user intent. Left in the mutation class it let a flapping client spend
    // the whole 60/min budget on handshakes and 429 the rest of the app.
    expect(shouldBypassRateLimit('/v1/realtime/token')).toBe(true);
    expect(shouldBypassRateLimit('/v1/agui/sessions/foo')).toBe(true);
  });

  it('does NOT bypass regular JSON endpoints', () => {
    expect(shouldBypassRateLimit('/v1/users/me')).toBe(false);
    expect(shouldBypassRateLimit('/v1/spaces')).toBe(false);
    expect(shouldBypassRateLimit('/v1/spaces/abc/action-center')).toBe(false);
    expect(shouldBypassRateLimit('/v1/spaces/abc/proposals?pendingOnly=true')).toBe(false);
    expect(shouldBypassRateLimit('/v1/spaces/abc/proposals/123/ratify')).toBe(false);
  });

  it('session events polling is rate-limited like other JSON endpoints', () => {
    expect(shouldBypassRateLimit('/v1/sessions/abc-123/events')).toBe(false);
    expect(shouldBypassRateLimit('/v1/sessions/abc-123/events?limit=50')).toBe(false);
  });
});

// ============================================================================
// Signup class — per-IP fixed window at the JIT provisioning call site
// ============================================================================

function fakeSignupStore(): FixedWindowStore & { ttls: Map<string, number> } {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    ttls,
    incr: async (key) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    expire: async (key, seconds, _mode) => {
      if (!ttls.has(key)) ttls.set(key, seconds);
      return 1;
    },
  };
}

describe('consumeSignupRateLimit', () => {
  it('admits up to the per-window cap, then blocks', async () => {
    const store = fakeSignupStore();
    for (let i = 0; i < RATE_LIMIT_SIGNUPS_PER_HOUR; i++) {
      expect(await consumeSignupRateLimit(store, '203.0.113.1')).toBe(true);
    }
    expect(await consumeSignupRateLimit(store, '203.0.113.1')).toBe(false);
  });

  it('keys per IP — one saturated address does not block another', async () => {
    const store = fakeSignupStore();
    for (let i = 0; i <= RATE_LIMIT_SIGNUPS_PER_HOUR; i++) {
      await consumeSignupRateLimit(store, '203.0.113.1');
    }
    expect(await consumeSignupRateLimit(store, '203.0.113.2')).toBe(true);
    expect(signupRateLimitKey('203.0.113.1')).not.toBe(signupRateLimitKey('203.0.113.2'));
  });

  it('sets the window TTL on the counter key', async () => {
    const store = fakeSignupStore();
    await consumeSignupRateLimit(store, '203.0.113.1');
    expect(store.ttls.get(signupRateLimitKey('203.0.113.1'))).toBe(
      SIGNUP_RATE_LIMIT_WINDOW_MS / 1000,
    );
  });

  it('signup cap is much tighter than the mutation class — signups are rare acts', () => {
    const windowsPerSignupWindow = SIGNUP_RATE_LIMIT_WINDOW_MS / RATE_LIMIT_WINDOW_MS;
    const mutationsPerSignupWindow = RATE_LIMIT_MUTATIONS_PER_MIN * windowsPerSignupWindow;
    expect(RATE_LIMIT_SIGNUPS_PER_HOUR).toBeLessThan(mutationsPerSignupWindow);
  });
});

// ============================================================================
// Invite-request class — per-IP AND per-email fixed windows
// ============================================================================

describe('consumeInviteRequestRateLimit', () => {
  it('admits up to the per-IP cap, then blocks that IP', async () => {
    const store = fakeSignupStore();
    for (let i = 0; i < RATE_LIMIT_INVITE_REQUESTS_PER_HOUR; i++) {
      expect(await consumeInviteRequestRateLimit(store, '203.0.113.1', `u${String(i)}@x.io`)).toBe(
        'allowed',
      );
    }
    expect(await consumeInviteRequestRateLimit(store, '203.0.113.1', 'fresh@x.io')).toBe(
      'ip_limited',
    );
    expect(await consumeInviteRequestRateLimit(store, '203.0.113.2', 'other@x.io')).toBe('allowed');
  });

  it('reports a saturated email distinctly, even from fresh IPs', async () => {
    const store = fakeSignupStore();
    for (let i = 0; i < RATE_LIMIT_INVITE_REQUESTS_PER_EMAIL_PER_DAY; i++) {
      expect(await consumeInviteRequestRateLimit(store, `198.51.100.${String(i)}`, 'a@x.io')).toBe(
        'allowed',
      );
    }
    expect(await consumeInviteRequestRateLimit(store, '198.51.100.99', 'a@x.io')).toBe(
      'email_limited',
    );
  });

  it('reports the caller-attributable ip_limited when both windows are exhausted', async () => {
    const store = fakeSignupStore();
    const attempts = Math.max(
      RATE_LIMIT_INVITE_REQUESTS_PER_HOUR,
      RATE_LIMIT_INVITE_REQUESTS_PER_EMAIL_PER_DAY,
    );
    for (let i = 0; i < attempts; i++) {
      await consumeInviteRequestRateLimit(store, '203.0.113.9', 'both@x.io');
    }
    expect(await consumeInviteRequestRateLimit(store, '203.0.113.9', 'both@x.io')).toBe(
      'ip_limited',
    );
  });

  it('email keys are hashed — the address never appears in the key', () => {
    const key = inviteRequestEmailRateLimitKey('somebody@example.com');
    expect(key).not.toContain('somebody');
    expect(key).not.toContain('@');
    expect(key).not.toBe(inviteRequestEmailRateLimitKey('other@example.com'));
  });
});

// ============================================================================
// Hook ordering — why the key cannot come from the resolved user
// ============================================================================

/**
 * `@fastify/rate-limit` computes its key in `onRequest`. `request.authUser` is
 * populated by the route's `preHandler`, which runs later — so a key built
 * from it silently degrades to the unauthenticated fallback for every request,
 * and every caller behind one proxy shares a bucket.
 *
 * The previous implementation did exactly that, and its unit tests passed
 * because they supplied a `userId` production never had. This asserts the
 * ordering itself, so the shape cannot regress without the reason surfacing.
 */
describe('rate limiting runs before authentication', () => {
  it('registers the limiter before the auth plugin', () => {
    const app = readFileSync(join(import.meta.dirname, '../app.ts'), 'utf8');
    const limiter = app.search(/register\(\s*rateLimit\b/);
    const auth = app.search(/register\(\s*authPlugin\b/);

    expect(limiter).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(-1);
    expect(limiter).toBeLessThan(auth);
  });

  it('derives the key from the credential, which is all that exists this early', () => {
    const keyGenerator = buildRateLimitOptions({ clientIp: () => '198.51.100.7' }).keyGenerator;
    const keyFor = (authorization: string | undefined) =>
      keyGenerator?.({ method: 'GET', headers: { authorization } } as never);

    // Two callers behind one IP must not share a bucket, and the only thing
    // separating them at `onRequest` is the credential they presented.
    expect(keyFor('Bearer alice')).not.toEqual(keyFor('Bearer bob'));
    expect(keyFor('Bearer alice')).toEqual(keyFor('Bearer alice'));
    // No credential is the anonymous bucket, keyed on the IP instead.
    expect(keyFor(undefined)).not.toEqual(keyFor('Bearer alice'));
  });
});
