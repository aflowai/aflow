/**
 * Tenant-scoped query execution via search_path.
 */
import { sql } from 'drizzle-orm';
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { getPerformanceLogThresholds } from '@aflow/lib';
import { isValidSchemaName } from './context.js';
import type { TenantContext } from './context.js';

/**
 * Execute a callback within a tenant's schema context.
 * Uses SET LOCAL search_path to ensure tenant isolation.
 *
 * CRITICAL: This must be used for ALL tenant-scoped database operations.
 */
export async function withTenantSchema<T>(
  db: PostgresJsDatabase,
  tenantContext: TenantContext,
  callback: (db: PostgresJsDatabase) => Promise<T>,
): Promise<T> {
  const { schemaName } = tenantContext;

  // Validate schema name to prevent injection
  if (!isValidSchemaName(schemaName)) {
    throw new Error(`Invalid tenant schema name: ${schemaName}`);
  }

  const tTx0 = Date.now();

  // Execute within a transaction with the correct search_path
  return await db.transaction(async (tx) => {
    const tTx1 = Date.now();
    // Set the search_path for this transaction only
    await tx.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}", public`));
    const tTx2 = Date.now();

    // Execute the callback
    const result = await callback(tx as unknown as PostgresJsDatabase);
    const tTx3 = Date.now();

    if (tTx3 - tTx0 > getPerformanceLogThresholds().slowQueryMs) {
      console.warn(`[PERF] withTenantSchema slow (${String(tTx3 - tTx0)}ms)`, {
        acquireConnectionMs: tTx1 - tTx0,
        setSearchPathMs: tTx2 - tTx1,
        callbackMs: tTx3 - tTx2,
        schema: schemaName,
      });
    }

    return result;
  });
}

/**
 * Execute a callback within a tenant's schema context using raw SQL.
 * Useful for migrations and DDL operations.
 */
export async function withTenantSchemaRaw(
  sqlClient: postgres.Sql,
  tenantContext: TenantContext,
  callback: (schemaName: string) => Promise<void>,
): Promise<void> {
  const { schemaName } = tenantContext;

  // Validate schema name to prevent injection
  if (!isValidSchemaName(schemaName)) {
    throw new Error(`Invalid tenant schema name: ${schemaName}`);
  }

  // Execute within a transaction
  await sqlClient.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO "${schemaName}", public`);
    await callback(schemaName);
  });
}
