import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { createTenantContext, spaces, withTenantSchema } from '@aflow/database';
import {
  resolveSpaceAutonomyPolicy,
  type ResolvedSpaceAutonomyPolicy,
  type TenantId,
} from '@aflow/schemas';

/**
 * A space's autonomy setting as every reader sees it (Plan 345 D): the
 * defaults where none is stored, or where the space is not found.
 */
export async function readSpaceAutonomyPolicy(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<ResolvedSpaceAutonomyPolicy> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId as TenantId), async (tx) =>
    tx
      .select({ autonomyPolicy: spaces.autonomyPolicy })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1),
  );
  return resolveSpaceAutonomyPolicy(rows[0]?.autonomyPolicy);
}

/**
 * The user a platform-made change is recorded under: the space's owner, who
 * holds an irremovable admin membership. Null where the space has none.
 */
export async function readSpaceOwnerUserId(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<string | null> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId as TenantId), async (tx) =>
    tx.select({ ownerId: spaces.ownerId }).from(spaces).where(eq(spaces.id, spaceId)).limit(1),
  );
  return rows[0]?.ownerId ?? null;
}
