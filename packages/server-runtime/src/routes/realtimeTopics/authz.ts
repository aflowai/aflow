import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import { and, eq, sql } from 'drizzle-orm';
import {
  createTenantContext,
  sessions,
  spaceMemberships,
  spaces,
  tenantMemberships,
  withTenantSchema,
} from '@aflow/database';
import { isForeignSoloSpace } from '@aflow/authz';
import { getSessionStateSafe } from '@aflow/redis';
import type { TenantId } from '@aflow/schemas';

const SPACE_AUTHZ_TTL_MS = 30_000;
const cache = new Map<string, { allowed: boolean; expiresAt: number }>();
// Bumped on every invalidation so an in-flight check that started before the
// eviction cannot repopulate the cache with its stale answer.
let cacheEpoch = 0;

function cacheKey(tenantId: string, userId: string, spaceId: string, isDevBypass: boolean): string {
  return `${tenantId}|${userId}|${spaceId}|${isDevBypass ? 'dev' : 'normal'}`;
}

function cacheGet(key: string): boolean | undefined {
  const v = cache.get(key);
  if (!v) return undefined;
  if (v.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return v.allowed;
}

function cacheSet(key: string, allowed: boolean, epochAtRead: number): void {
  if (epochAtRead !== cacheEpoch) return;
  cache.set(key, { allowed, expiresAt: Date.now() + SPACE_AUTHZ_TTL_MS });
}

export async function canReadSpace(
  db: PostgresJsDatabase,
  tenantId: string,
  userId: string,
  spaceId: string,
  authMethod?: string,
): Promise<boolean> {
  const isDevBypass = process.env['NODE_ENV'] !== 'production' && authMethod === 'dev_bypass';
  const key = cacheKey(tenantId, userId, spaceId, isDevBypass);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const epochAtRead = cacheEpoch;

  const tenantRows = await db
    .select({ role: tenantMemberships.role })
    .from(tenantMemberships)
    .where(
      and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.userId, userId),
        eq(tenantMemberships.status, 'active'),
      ),
    )
    .limit(1);
  const tenantRole = tenantRows[0]?.role;
  if (!tenantRole && !isDevBypass) {
    // No active tenant membership ⇒ REST surface would reject; do the
    // same here.
    cacheSet(key, false, epochAtRead);
    return false;
  }

  // 1. Space attributes — lives in the per-tenant schema. Owner grant plus
  //    the solo-space cap on the tenant-admin/dev-bypass grant below.
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const spaceRows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx.select({ ownerId: spaces.ownerId }).from(spaces).where(eq(spaces.id, spaceId)).limit(1),
  );
  const spaceRow = spaceRows[0];
  if (spaceRow?.ownerId === userId) {
    cacheSet(key, true, epochAtRead);
    return true;
  }

  // 2. Dev bypass (never production). Space content requires ownership or
  //    an explicit membership row for everyone else — tenant admins hold
  //    management authority elsewhere, never implicit content access. The
  //    bypass stays capped on a foreign solo space.
  if (isDevBypass) {
    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(spaceMemberships)
      .where(and(eq(spaceMemberships.tenantId, tenantId), eq(spaceMemberships.spaceId, spaceId)));
    const foreignSolo =
      spaceRow !== undefined &&
      isForeignSoloSpace(
        { ownerId: spaceRow.ownerId, memberCount: countRows[0]?.count ?? 0 },
        userId,
      );
    if (!foreignSolo) {
      cacheSet(key, true, epochAtRead);
      return true;
    }
  }

  // 3. Explicit membership row.
  const memberRows = await db
    .select({ role: spaceMemberships.role })
    .from(spaceMemberships)
    .where(
      and(
        eq(spaceMemberships.userId, userId),
        eq(spaceMemberships.spaceId, spaceId),
        eq(spaceMemberships.tenantId, tenantId),
      ),
    )
    .limit(1);
  const allowed = Boolean(memberRows[0]?.role);
  cacheSet(key, allowed, epochAtRead);
  return allowed;
}

export async function canReadSession(
  db: PostgresJsDatabase,
  redis: Redis | null,
  tenantId: string,
  userId: string,
  sessionId: string,
  /** Threaded into `canReadSpace` — see its doc for the dev-bypass
   *  rationale. Caller passes `ctx.connection.token.authMethod`. */
  authMethod?: string,
): Promise<boolean> {
  const verbose = process.env['REALTIME_VERBOSE_LOGS'] === '1';
  // 1. Redis hot state — primary source for active sessions.
  if (redis) {
    const result = await getSessionStateSafe(redis, tenantId, sessionId);
    if (result.ok && result.state.spaceId) {
      const ok = await canReadSpace(db, tenantId, userId, result.state.spaceId, authMethod);
      if (verbose) {
        console.info(
          `[canReadSession] redis-hit tenantId=${tenantId} userId=${userId} sessionId=${sessionId} spaceId=${result.state.spaceId} allowed=${String(
            ok,
          )}`,
        );
      }
      return ok;
    }
    if (verbose) {
      console.info(
        `[canReadSession] redis-miss tenantId=${tenantId} sessionId=${sessionId} reason=${
          result.ok ? 'no-spaceId-in-state' : result.kind
        } — falling back to Postgres`,
      );
    }
  }

  // 2. Postgres — for flushed/historical sessions.
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({ spaceId: sessions.spaceId })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1),
  );
  const spaceId = rows[0]?.spaceId;
  if (!spaceId) {
    if (verbose) {
      console.info(
        `[canReadSession] postgres-miss tenantId=${tenantId} sessionId=${sessionId} — denying`,
      );
    }
    return false;
  }
  const ok = await canReadSpace(db, tenantId, userId, spaceId, authMethod);
  if (verbose) {
    console.info(
      `[canReadSession] postgres-hit tenantId=${tenantId} userId=${userId} sessionId=${sessionId} spaceId=${spaceId} allowed=${String(
        ok,
      )}`,
    );
  }
  return ok;
}

/**
 * Evict the in-process authz cache for a (tenant, user) — both partitions,
 * optionally narrowed to one space. Called on membership-revocation
 * invalidation so an open-stream re-check cannot ride a stale `true` for up
 * to the TTL.
 */
export function invalidateRealtimeSpaceAuthzCache(
  tenantId: string,
  userId: string,
  spaceId?: string,
): void {
  cacheEpoch++;
  for (const key of [...cache.keys()]) {
    const [keyTenant, keyUser, keySpace] = key.split('|');
    if (keyTenant !== tenantId || keyUser !== userId) continue;
    if (spaceId !== undefined && keySpace !== spaceId) continue;
    cache.delete(key);
  }
}

/** Test-only — clears the in-process cache. */
export function __resetAuthzCacheForTests(): void {
  cache.clear();
  cacheEpoch = 0;
}
