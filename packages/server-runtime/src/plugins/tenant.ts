/**
 * Tenant Context Plugin
 *
 * Extracts and validates tenant context for every authenticated request.
 *
 * Tenant resolution priority:
 *   1. **API key** — When the request is authenticated via API key, the
 *      tenant is taken from the key's bound `tenantId` (immutable).
 *   2. **X-Tenant-ID header** — Explicit per-request tenant override.
 *   3. **JWT custom claim** — `tenant_id` or namespaced equivalent.
 *   4. **DEFAULT_TENANT_ID env** — Development fallback only.
 *
 * An edition whose tenancy is `fixed` pins the outcome to its one tenant and
 * rejects a request naming another; the sources above then only decide whether
 * the request agrees with the instance, never which tenant it reaches. Their
 * precedence stops applying there: every supplied source is an agreement check,
 * so one that disagrees is a refusal even when a higher-precedence source
 * agrees.
 *
 * Access control:
 *   - The user must hold an **active** `tenant_memberships` row for the
 *     resolved tenant.
 *   - Membership role is cached in Redis (`aflow:rbac:tenant:{userId}:{tenantId}`)
 *     with a 2-minute TTL.
 *   - A Pub/Sub listener on `aflow:pubsub:rbac-invalidate` evicts cache
 *     entries when memberships change.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import { tenantMemberships } from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import type { TenantRole } from '@aflow/schemas';
import {
  RBAC_TENANT_CACHE_PREFIX,
  RBAC_CACHE_TTL,
  RBAC_INVALIDATE_CHANNEL,
  parseRbacInvalidationMessage,
  rbacKeysForInvalidation,
  invalidateSpaceAttributesCache,
} from '@aflow/authz';
import { invalidateRealtimeSpaceAuthzCache } from '../routes/realtimeTopics/authz.js';
import { closeRealtimeConnectionsForUser } from '../routes/realtime.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Tenant context for the current request.
 */
export interface TenantContext {
  /** Tenant ID */
  tenantId: TenantId;
  /** Tenant role of the authenticated user */
  tenantRole: TenantRole;
  /** Whether this is an admin-level request (owner or admin role) */
  isAdmin: boolean;
}

/** One place a request named a tenant, labelled for a refusal message. */
interface TenantSelector {
  source: string;
  tenantId: string;
}

/** Renders selector labels as `a`, `b and c`. */
function joinSources(sources: string[]): string {
  const last = sources.slice(-1).join('');
  const rest = sources.slice(0, -1);
  return rest.length > 0 ? `${rest.join(', ')} and ${last}` : last;
}

// Extend Fastify types
declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantContext;
    requireTenant(): Promise<TenantContext>;
  }
}

// ============================================================================
// Plugin
// ============================================================================

export const tenantPlugin = fp(
  async (fastify: FastifyInstance) => {
    // Initialize tenant property on request (undefined by default, computed lazily)
    fastify.decorateRequest('tenant', undefined);

    // ---- Pub/Sub cache invalidation listener --------------------------------
    // Uses a dedicated subscriber connection so it doesn't interfere with the
    // main Redis client.
    const ctx = fastify.appContext;
    if (ctx?.redis) {
      try {
        // A dedicated connection, because a subscriber cannot issue other
        // commands. Built through the shared helper so it carries the same
        // AUTH password and TLS policy as every other connection.
        const { createSubscriberConnection, getRedisConfig } = await import('@aflow/redis');
        const subscriber = createSubscriberConnection(
          { ...getRedisConfig(), connectionName: 'rbac-invalidation-subscriber' },
          {
            debug: (message, data) => {
              fastify.log.debug(data ?? {}, message);
            },
            error: (message, data) => {
              fastify.log.error(data ?? {}, message);
            },
          },
        );

        subscriber.subscribe(RBAC_INVALIDATE_CHANNEL).catch((err: unknown) => {
          fastify.log.warn({ err }, 'Failed to subscribe to RBAC invalidation channel');
        });

        subscriber.on('message', (channel: string, message: string) => {
          if (channel !== RBAC_INVALIDATE_CHANNEL) return;
          if (!ctx.redis) return;

          const parsed = parseRbacInvalidationMessage(message);
          if (!parsed) {
            fastify.log.warn({ message }, 'Malformed RBAC invalidation message — ignoring');
            return;
          }

          const { exact, patterns } = rbacKeysForInvalidation(parsed);

          // Delete exact keys immediately
          if (exact.length > 0) {
            ctx.redis.del(...exact).catch((err: unknown) => {
              fastify.log.warn({ err, keys: exact }, 'Failed to evict exact RBAC cache keys');
            });
          }

          // Membership changes flip memberCount — the user-independent space
          // attributes cache must not serve the stale solo/shared state.
          if (parsed.spaceId) {
            invalidateSpaceAttributesCache(ctx.redis, parsed.tenantId, parsed.spaceId).catch(
              (err: unknown) => {
                fastify.log.warn({ err }, 'Failed to evict space attributes cache');
              },
            );
          }

          // Realtime enforcement: evict the in-process authz cache and tear
          // down the user's live connections — subscriptions authorize only
          // at subscribe time, so a revoked member must not keep receiving
          // events. Clients reconnect and re-subscribe against fresh caches.
          invalidateRealtimeSpaceAuthzCache(parsed.tenantId, parsed.userId, parsed.spaceId);
          const closedConnections = closeRealtimeConnectionsForUser(parsed.tenantId, parsed.userId);
          if (closedConnections > 0) {
            fastify.log.info(
              { userId: parsed.userId, tenantId: parsed.tenantId, closedConnections },
              'Closed realtime connections after membership invalidation',
            );
          }

          // Scan and delete pattern-matched keys (space wildcards)
          for (const pattern of patterns) {
            ctx.redis
              .keys(pattern)
              .then((keys) => {
                if (keys.length > 0) {
                  return ctx.redis!.del(...keys);
                }
                return undefined;
              })
              .catch((err: unknown) => {
                fastify.log.warn({ err, pattern }, 'Failed to evict pattern RBAC cache keys');
              });
          }
        });

        // Clean up subscriber on server close
        fastify.addHook('onClose', async () => {
          await subscriber.quit();
        });

        fastify.log.info('RBAC cache invalidation subscriber active');
      } catch (err) {
        fastify.log.warn({ err }, 'Failed to set up RBAC cache invalidation subscriber');
      }
    }

    // ---- Helper: look up tenant membership role ----------------------------
    async function resolveMembershipRole(userId: string, tenantId: string): Promise<string | null> {
      const appCtx = fastify.appContext;
      if (!appCtx?.db) return null;

      const db = appCtx.db as PostgresJsDatabase;
      const redis = appCtx.redis;

      // Check Redis cache first
      if (redis) {
        const cacheKey = `${RBAC_TENANT_CACHE_PREFIX}:${userId}:${tenantId}`;
        try {
          const cached = await redis.get(cacheKey);
          if (cached) return cached;
        } catch {
          // Redis failure — fall through to DB
        }
      }

      // DB lookup
      const rows = await db
        .select({ role: tenantMemberships.role })
        .from(tenantMemberships)
        .where(
          and(
            eq(tenantMemberships.userId, userId),
            eq(tenantMemberships.tenantId, tenantId),
            eq(tenantMemberships.status, 'active'),
          ),
        )
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      const role = row.role;

      // Cache the result
      if (redis) {
        const cacheKey = `${RBAC_TENANT_CACHE_PREFIX}:${userId}:${tenantId}`;
        redis.set(cacheKey, role, 'EX', RBAC_CACHE_TTL).catch((err: unknown) => {
          fastify.log.warn({ err, cacheKey }, 'Failed to cache RBAC role');
        });
      }

      return role;
    }

    // ---- requireTenant() — lazy async tenant extraction --------------------
    fastify.decorateRequest(
      'requireTenant',
      async function (this: FastifyRequest): Promise<TenantContext> {
        // Return cached tenant if already extracted
        if (this.tenant) {
          return this.tenant;
        }

        // Require authenticated user
        if (!this.authUser) {
          throw fastify.httpErrors.unauthorized('Authentication required');
        }

        const authUser = this.authUser;

        // ---- Resolve tenant ID ----

        // Every source the request can name a tenant through, in precedence
        // order. Multi-tenant resolution honours the first; fixed tenancy reads
        // all of them, because a selector there is an agreement check rather
        // than a choice.
        const selectors: TenantSelector[] = [];

        if (authUser.authMethod === 'api_key' && authUser.apiKeyTenantId) {
          selectors.push({ source: 'the API key', tenantId: authUser.apiKeyTenantId });
        }

        const headerTenant = this.headers['x-tenant-id'];
        if (typeof headerTenant === 'string' && headerTenant.length > 0) {
          selectors.push({ source: 'the X-Tenant-ID header', tenantId: headerTenant });
        }

        if (authUser.claims) {
          const claims = authUser.claims;
          const tenantKey = Object.keys(claims).find(
            (key) => key.endsWith('/tenant_id') || key === 'tenant_id',
          );
          const claimed = tenantKey === undefined ? undefined : claims[tenantKey];
          if (typeof claimed === 'string') {
            selectors.push({ source: 'the tenant claim in the token', tenantId: claimed });
          }
        }

        let tenantId: string | undefined;
        const tenancy = fastify.edition.tenancy;

        if (tenancy.mode === 'fixed') {
          // The instance serves one tenant, so a request naming another is not
          // a selection to honour — it is a caller that believes it reached a
          // different instance, and answering it from this one would be the
          // wrong tenant's data either way. A source that agrees does not
          // excuse one that disagrees, so the refusal reads every selector
          // instead of only the one precedence would have taken.
          const conflicting = selectors.filter(
            (selector) => selector.tenantId !== tenancy.tenantId,
          );
          if (conflicting.length > 0) {
            throw fastify.httpErrors.badRequest(
              `This instance is pinned to a single tenant, and the request names a different one via ${joinSources(
                conflicting.map((selector) => selector.source),
              )}. Its workspaces are spaces within the pinned tenant, so a tenant selector must be omitted or name that tenant.`,
            );
          }
          tenantId = tenancy.tenantId;
        } else {
          tenantId = selectors[0]?.tenantId;

          // Development fallback
          if (!tenantId && process.env['NODE_ENV'] !== 'production') {
            tenantId = process.env['DEFAULT_TENANT_ID'];
          }
        }

        if (!tenantId) {
          throw fastify.httpErrors.badRequest(
            'Missing tenant context. Provide X-Tenant-ID header or include tenant in token.',
          );
        }

        // ---- Verify membership ----

        let role: string | null = null;

        // The local appliance's instance credential IS the owner; there is no
        // membership to look up, and requiring one would make the API depend on
        // a row bootstrap has not necessarily written yet.
        if (tenancy.mode === 'fixed' && authUser.authMethod === 'local') {
          role = 'owner';
        }

        // Dev bypass: in development mode with dev_bypass auth, allow owner access
        const isDevelopment = process.env['NODE_ENV'] !== 'production';
        if (!role && isDevelopment && authUser.authMethod === 'dev_bypass') {
          role = 'owner';
        }

        // For API key auth, the membership was already verified when the key was created.
        // We still look up the role for proper context.
        if (!role) {
          role = await resolveMembershipRole(authUser.userId, tenantId);
        }

        if (!role) {
          throw fastify.httpErrors.forbidden('You do not have access to this tenant.');
        }

        const isAdmin = role === 'owner' || role === 'admin';

        // Cache and return tenant context
        this.tenant = {
          tenantId: tenantId as TenantId,
          tenantRole: role as TenantRole,
          isAdmin,
        };

        return this.tenant;
      },
    );
  },
  { name: 'tenant-plugin', dependencies: ['edition-plugin', 'auth-plugin'] },
);
