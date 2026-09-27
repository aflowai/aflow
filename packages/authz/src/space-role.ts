import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { spaceMemberships } from '@aflow/database';
import { getCachedSpaceRole, setCachedSpaceRole, RBAC_CACHE_TTL } from './cache.js';

/**
 * The role a user currently holds in a space, or null if they hold none.
 *
 * Shared because two callers need the same answer for different reasons: the
 * request boundary authorizes an incoming call, and the orchestrator checks
 * whether a long-running run's established authority still holds. A run can
 * outlive the access it started with, and the two must not drift.
 */
export async function resolveSpaceRole(
  db: PostgresJsDatabase,
  redis: Redis | null | undefined,
  params: { userId: string; tenantId: string; spaceId: string },
  onCacheError?: (err: unknown) => void,
): Promise<string | null> {
  const { userId, tenantId, spaceId } = params;

  if (redis) {
    try {
      const cached = await getCachedSpaceRole(redis, userId, tenantId, spaceId);
      if (cached) return cached;
    } catch (err) {
      onCacheError?.(err);
    }
  }

  const rows = await db
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

  const role = rows[0]?.role ?? null;
  if (role && redis) {
    setCachedSpaceRole(redis, userId, tenantId, spaceId, role, RBAC_CACHE_TTL).catch(
      (err: unknown) => onCacheError?.(err),
    );
  }

  return role;
}
