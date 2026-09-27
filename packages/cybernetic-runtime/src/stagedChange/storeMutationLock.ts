import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export function storeMutationLockKey(spaceId: string): string {
  return `store-mutation:${spaceId}`;
}

/**
 * Space-scoped advisory lock serializing every store mutation (skill, bundle,
 * and connector installs; later update/uninstall). Transaction-scoped and
 * non-blocking. Advisory locks are reentrant within the owning session, so a
 * store-level transaction can wrap a backend that acquires the lock again.
 */
export async function tryAcquireStoreMutationLock(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<boolean> {
  const result = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${storeMutationLockKey(spaceId)})) as acquired`,
  );
  const rows = result as unknown as Array<{ acquired: boolean }>;
  return rows[0]?.acquired === true;
}
