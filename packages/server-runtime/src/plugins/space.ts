/**
 * Space Context Plugin
 *
 * Extracts and validates space context for every authenticated request.
 * Space is MANDATORY — every operation happens within a space.
 *
 * Space resolution priority:
 *   1. **X-Space-ID header** — Primary mechanism (set once by UI/client).
 *   2. **`spaceId` query parameter** — Convenience for URL-driven navigation.
 *   3. **User's first owned space** — Fallback in development only.
 *
 * Access control:
 *   - The user must own the space or hold a `space_memberships` row for it —
 *     tenant admins get management authority elsewhere, never implicit
 *     content access here.
 *   - Space role is cached in Redis with a 2-minute TTL.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import { spaceMemberships, createTenantContext, withTenantSchema, spaces } from '@aflow/database';
import type { SpaceId, TenantId } from '@aflow/schemas';
import type { SpaceRole } from '@aflow/schemas';
import { isForeignSoloSpace, resolveSpaceRole as sharedResolveSpaceRole } from '@aflow/authz';

// ============================================================================
// Types
// ============================================================================

export interface SpaceContext {
  /** Space ID */
  spaceId: SpaceId;
  /** User's role in this space */
  spaceRole: SpaceRole;
  /** Whether the user can write (admin or editor) */
  canWrite: boolean;
  /** Whether user is space admin */
  isSpaceAdmin: boolean;
  /** Owning user */
  ownerId: string | null;
  /** Explicit membership rows — solo (≤1) spaces are private to their owner */
  memberCount: number;
}

// Extend Fastify types
declare module 'fastify' {
  interface FastifyRequest {
    space?: SpaceContext;
    requireSpace(): Promise<SpaceContext>;
  }
  interface FastifyContextConfig {
    allowArchived?: boolean;
  }
}

// ============================================================================

const SPACE_ARCHIVED_CACHE_TTL_SECONDS = 5 * 60;
const ARCHIVED_CACHE_ACTIVE_SENTINEL = '-';

function spaceArchivedCacheKey(spaceId: string): string {
  return `space:archived:${spaceId}`;
}

// ============================================================================
// Plugin
// ============================================================================

/**
 * The space a request names, in the order the surfaces declare it.
 *
 * One function because there are two readers — the archived-space guard and
 * `requireSpace()` — and a comment claiming they agreed is what let them
 * disagree: the guard read the route parameter first while `requireSpace`
 * never read it at all, so a request was checked against the space in its path
 * and then served the space in its header.
 *
 * The dev fallback is deliberately NOT here. Guessing a space is a last resort
 * for a caller that named none, never a way to decide which of two a caller
 * meant.
 *
 * Exported for direct coverage: the precedence is the whole of it.
 */
export function spaceIdFromRequest(request: {
  params?: unknown;
  headers: Record<string, unknown>;
  query?: unknown;
}): string | undefined {
  const params = request.params as Record<string, unknown> | undefined;
  const param = params?.['spaceId'];
  if (typeof param === 'string' && param.length > 0) return param;

  const header = request.headers['x-space-id'];
  if (typeof header === 'string' && header.length > 0) return header;

  const query = request.query as Record<string, unknown> | undefined;
  const queryValue = query?.['spaceId'];
  if (typeof queryValue === 'string' && queryValue.length > 0) return queryValue;

  return undefined;
}

export const spacePlugin = fp(
  async (fastify: FastifyInstance) => {
    fastify.decorateRequest('space', undefined);

    // ---- Helper: look up space membership role ----------------------------
    async function resolveSpaceRole(
      userId: string,
      tenantId: string,
      spaceId: string,
    ): Promise<string | null> {
      const appCtx = fastify.appContext;
      if (!appCtx?.db) return null;

      return sharedResolveSpaceRole(
        appCtx.db as PostgresJsDatabase,
        appCtx.redis,
        { userId, tenantId, spaceId },
        (err: unknown) => {
          fastify.log.warn({ err }, 'Space role cache unavailable');
        },
      );
    }

    // ---- Helper: get user's first owned space ID (dev fallback) ----------
    async function getOwnedSpaceId(tenantId: string, userId: string): Promise<string | null> {
      const appCtx = fastify.appContext;
      if (!appCtx?.db) return null;

      const db = appCtx.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenantId as TenantId);

      try {
        const result = await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
          return (tx as PostgresJsDatabase)
            .select({ id: spaces.id })
            .from(spaces)
            .where(eq(spaces.ownerId, userId))
            .orderBy(spaces.createdAt)
            .limit(1);
        });

        const rows = result as Array<{ id: string }>;
        return rows[0]?.id ?? null;
      } catch {
        return null;
      }
    }

    // ---- Helper: fetch space info (exists + ownerId + memberCount + archivedAt) ----------
    async function getSpaceInfo(
      tenantId: string,
      spaceId: string,
    ): Promise<{
      id: string;
      ownerId: string | null;
      memberCount: number;
      archivedAt: Date | null;
    } | null> {
      const appCtx = fastify.appContext;
      if (!appCtx?.db) return null;

      const db = appCtx.db as PostgresJsDatabase;
      const tenantCtx = createTenantContext(tenantId as TenantId);

      try {
        const result = await withTenantSchema(db, tenantCtx, async (tx: unknown) => {
          return (tx as PostgresJsDatabase)
            .select({
              id: spaces.id,
              ownerId: spaces.ownerId,
              archivedAt: spaces.archivedAt,
            })
            .from(spaces)
            .where(eq(spaces.id, spaceId))
            .limit(1);
        });

        const rows = result as Array<{
          id: string;
          ownerId: string | null;
          archivedAt: Date | null;
        }>;
        const row = rows[0];
        if (!row) return null;

        const { sql } = await import('drizzle-orm');
        const countRows = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(spaceMemberships)
          .where(
            and(eq(spaceMemberships.tenantId, tenantId), eq(spaceMemberships.spaceId, spaceId)),
          );
        return { ...row, memberCount: countRows[0]?.count ?? 0 };
      } catch {
        return null;
      }
    }

    async function getSpaceArchivedAt(tenantId: string, spaceId: string): Promise<string | null> {
      const appCtx = fastify.appContext;
      const redis = appCtx?.redis;
      const cacheKey = spaceArchivedCacheKey(spaceId);

      if (redis) {
        try {
          const cached = await redis.get(cacheKey);
          if (cached !== null) {
            return cached === ARCHIVED_CACHE_ACTIVE_SENTINEL ? null : cached;
          }
        } catch {
          // Redis miss/failure — fall through to DB.
        }
      }

      const info = await getSpaceInfo(tenantId, spaceId);
      const value = info?.archivedAt ? info.archivedAt.toISOString() : null;

      if (redis) {
        const cacheValue = value ?? ARCHIVED_CACHE_ACTIVE_SENTINEL;
        redis
          .setex(cacheKey, SPACE_ARCHIVED_CACHE_TTL_SECONDS, cacheValue)
          .catch((err: unknown) => {
            fastify.log.warn({ err, spaceId }, 'Failed to cache space archived state');
          });
      }
      return value;
    }

    fastify.addHook('preHandler', async (request, reply) => {
      // Per-route opt-out (unarchive, preview-archive, etc.)
      const config = request.routeOptions?.config as { allowArchived?: boolean } | undefined;
      if (config?.allowArchived === true) return;

      // Health/auth/etc. don't have a tenant context. Skip if unauthenticated.
      if (!request.authUser) return;

      // No space named anywhere means the route is not space-scoped; let it
      // through. Same resolution `requireSpace()` uses, from the same function.
      const spaceIdRaw = spaceIdFromRequest(request);
      if (!spaceIdRaw) return;

      const tenant = await request.requireTenant();
      const archivedAt = await getSpaceArchivedAt(tenant.tenantId, spaceIdRaw);
      if (archivedAt === null) return;

      // Read-only inspection bypass (tenant admins on GET with
      // `?includeArchived=true`). Lets the operator inspect an archived
      // space's metadata without unarchiving first.
      const query = request.query as Record<string, unknown> | undefined;
      const includeArchivedFlag =
        query &&
        (query['includeArchived'] === 'true' ||
          query['includeArchived'] === true ||
          query['archived'] === 'true');
      if (request.method === 'GET' && includeArchivedFlag && tenant.isAdmin) {
        return;
      }

      reply.code(410).send({
        error: 'SPACE_ARCHIVED',
        spaceId: spaceIdRaw,
        archivedAt,
        message: `Space '${spaceIdRaw}' is archived (archived at ${archivedAt}). Unarchive it to restore access.`,
      });
    });

    // ---- requireSpace() — lazy async space extraction --------------------
    fastify.decorateRequest(
      'requireSpace',
      async function (this: FastifyRequest): Promise<SpaceContext> {
        if (this.space) {
          return this.space;
        }

        // Require tenant context first
        const tenant = await this.requireTenant();

        if (!this.authUser) {
          throw fastify.httpErrors.unauthorized('Authentication required');
        }

        const authUser = this.authUser;

        // ---- Resolve space ID ----
        //
        // The route parameter wins where a path declares one, because that is
        // where authorization already reads it (`resourceIdFrom: 'param'`).
        // Taking the handler's space from the header instead let the two
        // disagree: a request checked against the space in its path went on to
        // read and write the space in its header, and in development — where
        // the last resort is "the user's first owned space" — a caller that
        // sent no header operated on a space it never named. Both spaces are
        // access-checked below, so this was a wrong-target write rather than a
        // reachable one, and silent either way.
        let spaceId = spaceIdFromRequest(this);

        // Last resort, and only outside production: a caller that named no
        // space anywhere gets its own.
        if (!spaceId && process.env['NODE_ENV'] !== 'production') {
          spaceId = (await getOwnedSpaceId(tenant.tenantId, authUser.userId)) ?? undefined;
        }

        if (!spaceId) {
          throw fastify.httpErrors.badRequest(
            'Missing space context. Provide X-Space-ID header or spaceId query parameter.',
          );
        }

        // ---- Validate space exists + fetch ownerId ----

        const spaceInfo = await getSpaceInfo(tenant.tenantId, spaceId);
        if (!spaceInfo) {
          throw fastify.httpErrors.notFound(`Space ${spaceId} not found in this tenant.`);
        }

        // ---- Verify access ----

        let role: string | null = null;

        // Space content requires ownership or an explicit membership row —
        // tenant admins hold management authority elsewhere, never implicit
        // content access here. Dev-bypass keeps its dev-only shortcut, still
        // capped on a foreign solo space.
        if (spaceInfo.ownerId && authUser.userId === spaceInfo.ownerId) {
          role = 'admin';
        }

        const isDevelopment = process.env['NODE_ENV'] !== 'production';
        if (
          !role &&
          isDevelopment &&
          authUser.authMethod === 'dev_bypass' &&
          !isForeignSoloSpace(spaceInfo, authUser.userId)
        ) {
          role = 'admin';
        }

        // Otherwise, check space membership
        if (!role) {
          role = await resolveSpaceRole(authUser.userId, tenant.tenantId, spaceId);
        }

        if (!role) {
          throw fastify.httpErrors.forbidden('You do not have access to this space.');
        }

        const spaceRole = role as SpaceRole;
        const canWrite = spaceRole === 'admin' || spaceRole === 'editor';
        const isSpaceAdmin = spaceRole === 'admin';

        this.space = {
          spaceId: spaceId as SpaceId,
          spaceRole,
          canWrite,
          isSpaceAdmin,
          ownerId: spaceInfo.ownerId,
          memberCount: spaceInfo.memberCount,
        };

        return this.space;
      },
    );
  },
  { name: 'space-plugin', dependencies: ['auth-plugin', 'tenant-plugin'] },
);
