import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { RealtimeTokenResponseSchema, type RealtimeTokenClaims } from '@aflow/schemas';
import { resolveWebSocketOrigin } from '../lib/apiBaseUrl.js';

/**
 * Connect-window for the realtime token. Once the browser opens the
 * WS, the connection itself is long-lived — the token only gates the
 * UPGRADE handshake.
 */
const REALTIME_TOKEN_TTL_SECONDS = 60;

/** The web application's and the API's ports, as the development stack binds them. */
const DEVELOPMENT_PORTS = [3001, 3000] as const;

/** Every spelling a loopback origin arrives under; they compare as strings. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;

/**
 * An origin is a scheme and a host, so a value that is not one — `true`, the
 * setting that turns CORS on for every caller — names nothing and is left out.
 */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

export function resolveAllowedOrigins(): string[] {
  const origins = new Set<string>();
  const raw = process.env['REALTIME_ALLOWED_ORIGINS'] ?? process.env['CORS_ORIGIN'];
  if (raw) {
    for (const o of raw
      .split(',')
      .map((s) => s.trim())
      .filter(isOrigin)) {
      origins.add(o);
    }
  }
  // Outside production the development stack's own frontends are always
  // admitted, under every spelling of loopback: a tab opened at 127.0.0.1 is
  // the same machine as one at localhost, and a connect refused by spelling
  // reads as a broken stack.
  if (process.env['NODE_ENV'] !== 'production') {
    for (const host of LOOPBACK_HOSTS) {
      for (const port of DEVELOPMENT_PORTS) origins.add(`http://${host}:${String(port)}`);
    }
  }
  // Production with no explicit allowlist: empty list ⇒ every connect
  // is denied. Loud failure is better than a permissive default —
  // operators see the misconfiguration immediately.
  return [...origins];
}

/**
 * Resolve the WebSocket URL the browser should connect to.
 *
 * The gateway lives on the API host, and that is load-bearing rather than
 * incidental: the browser's CSP is compiled at web build time from the API
 * origin, so a socket anywhere else is refused before it opens. Nothing here
 * can detect that — the token mints happily and the connection dies in the
 * browser — which is why it is derived from the one origin the deployment
 * already declares rather than named separately.
 */
function resolveRealtimeUrl(): string {
  return `${resolveWebSocketOrigin()}/v1/realtime`;
}

// ============================================================================
// Token store
// ============================================================================

/**
 * Stored realtime-token record. `consumed` is set by the gateway on
 * connect via `GETDEL`; replay attempts find no key. The body is
 * stored as JSON in a single Redis string key with TTL.
 */
export interface StoredRealtimeToken extends RealtimeTokenClaims {
  /** ISO timestamp of when the token was minted (for diagnostics). */
  mintedAt: string;
}

function tokenKey(token: string): string {
  return `aflow:realtime:token:${token}`;
}

/**
 * In-process dev fallback for environments without Redis. **Never**
 * used in production — production always has Redis available, and a
 * memory token store can't survive a process restart. The dev path
 * matches Redis semantics: write with TTL, consume by delete.
 */
const inMemoryTokens = new Map<string, { record: StoredRealtimeToken; expiresAtMs: number }>();

function pruneExpiredMemoryTokens(): void {
  const now = Date.now();
  for (const [key, value] of inMemoryTokens) {
    if (value.expiresAtMs <= now) inMemoryTokens.delete(key);
  }
}

/**
 * Mint and store a token. Returns the raw token value the browser
 * passes via `Sec-WebSocket-Protocol`. Random 32-byte value, base64url
 * encoded so it survives a subprotocol header field intact (alphanumeric
 * + `-_`, no padding).
 */
export async function mintRealtimeToken(
  redis: Redis | null,
  claims: RealtimeTokenClaims,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const record: StoredRealtimeToken = { ...claims, mintedAt: new Date().toISOString() };
  if (redis) {
    await redis.set(tokenKey(token), JSON.stringify(record), 'EX', REALTIME_TOKEN_TTL_SECONDS);
  } else {
    pruneExpiredMemoryTokens();
    inMemoryTokens.set(token, {
      record,
      expiresAtMs: Date.now() + REALTIME_TOKEN_TTL_SECONDS * 1000,
    });
  }
  return token;
}

export async function consumeRealtimeToken(
  redis: Redis | null,
  token: string,
): Promise<StoredRealtimeToken | null> {
  if (redis) {
    // `GETDEL` is atomic — replay attempts see nothing.
    const raw = await redis.getdel(tokenKey(token));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredRealtimeToken;
    } catch {
      return null;
    }
  }
  pruneExpiredMemoryTokens();
  const entry = inMemoryTokens.get(token);
  if (!entry) return null;
  inMemoryTokens.delete(token);
  if (entry.expiresAtMs <= Date.now()) return null;
  return entry.record;
}

// ============================================================================
// Route
// ============================================================================

const TokenRequestSchema = z.object({
  /**
   * Optional pre-scope: limits which spaces/sessions this token can
   * subscribe to. Used by the BFF when the page already knows the
   * visible scope. Advisory only — the gateway re-checks per-subscribe.
   */
  allowedSpaceIds: z.array(z.string().uuid()).max(64).optional(),
  allowedSessionIds: z.array(z.string()).max(64).optional(),
});

export const realtimeTokenRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  app.post(
    '/token',
    {
      config: { authz: { resource: 'session', action: 'read', spaceIdFrom: 'none' } },
      schema: {
        tags: ['Realtime'],
        summary: 'Mint a short-lived realtime token',
        description: `
Mint a single-use opaque token the browser can use to upgrade to the
realtime WebSocket at \`/v1/realtime\`. Tokens expire 60s after mint
and are consumed on connect (replay rejected).

The token is delivered to the browser through a normal authenticated
JSON response; the browser passes it as the
\`phoenix.token.<token>\` WebSocket subprotocol (NOT in the URL — see
Plan 170 §5.1 for the security rationale).
        `.trim(),
        body: TokenRequestSchema,
        response: {
          200: RealtimeTokenResponseSchema,
          401: z.object({ error: z.string(), message: z.string() }),
          503: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const body = request.body;
      const userId = request.authUser?.userId;
      if (!userId) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Realtime token mint requires an authenticated user',
        });
      }

      const allowedOrigins = resolveAllowedOrigins();
      if (allowedOrigins.length === 0) {
        request.log.error(
          'Realtime token mint failed: no allowed origins configured. ' +
            'Set REALTIME_ALLOWED_ORIGINS or CORS_ORIGIN.',
        );
        return reply.status(503).send({
          error: 'ServiceUnavailable',
          message: 'Realtime transport is not configured on this server.',
        });
      }

      const now = Math.floor(Date.now() / 1000);
      const claims: RealtimeTokenClaims = {
        userId,
        tenantId: tenant.tenantId,
        allowedOrigins,
        ...(body.allowedSpaceIds && body.allowedSpaceIds.length > 0
          ? { allowedSpaceIds: body.allowedSpaceIds }
          : {}),
        ...(body.allowedSessionIds && body.allowedSessionIds.length > 0
          ? { allowedSessionIds: body.allowedSessionIds }
          : {}),
        exp: now + REALTIME_TOKEN_TTL_SECONDS,
        jti: crypto.randomUUID(),
        ...(request.authUser?.authMethod ? { authMethod: request.authUser.authMethod } : {}),
      };
      const token = await mintRealtimeToken(app.appContext.redis, claims);

      return reply.send({
        token,
        expiresAt: new Date((now + REALTIME_TOKEN_TTL_SECONDS) * 1000).toISOString(),
        realtimeUrl: resolveRealtimeUrl(),
      });
    },
  );
};
