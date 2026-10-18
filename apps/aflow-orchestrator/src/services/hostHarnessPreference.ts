/**
 * The coding agent a space prefers, carried to the machine that runs it
 * (Plan 326 D12).
 *
 * Read from the space when a harness run is dispatched and stamped on the job,
 * never written into the step's input: there a harness is one the caller
 * requires, which the machine refuses rather than swaps, while the space's
 * choice is a preference the machine falls back from when it does not have it
 * installed.
 */
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { createTenantContext, spaces, withTenantSchema } from '@aflow/database';
import { buildOperationId, type TenantId } from '@aflow/schemas';

const HARNESS_RUN_OPERATION = buildOperationId('host', 'harness', 'run');

/**
 * The space's preference, or none. A preference the machine is free to pass
 * over, so a read that fails — a tenant schema not yet migrated, a database
 * that does not answer — leaves the machine deciding rather than failing the
 * dispatch or the context that reads it.
 */
export async function readPreferredHarness(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<string | undefined> {
  try {
    const rows = (await withTenantSchema(
      db,
      createTenantContext(tenantId as TenantId),
      async (tx) =>
        tx
          .select({ preferredHarness: spaces.preferredHarness })
          .from(spaces)
          .where(eq(spaces.id, spaceId))
          .limit(1),
    )) as Array<{ preferredHarness: string | null }>;
    return rows[0]?.preferredHarness ?? undefined;
  } catch {
    return undefined;
  }
}

export async function preferredHarnessFor(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string | undefined,
  operationId: string,
): Promise<string | undefined> {
  if (operationId !== HARNESS_RUN_OPERATION || spaceId === undefined) return undefined;
  return await readPreferredHarness(db, tenantId, spaceId);
}
