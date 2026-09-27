/**
 * Apply migrations to all existing tenant schemas.
 */
import type postgres from 'postgres';
import { listTenantSchemas } from './schemaManagement.js';
import { applyTenantMigrations } from './migrations/apply.js';

/**
 * Apply migrations to all existing tenant schemas.
 * Used when deploying schema changes.
 */
export async function applyMigrationsToAllTenants(
  sqlClient: postgres.Sql,
  options: { maxConcurrency?: number } = {},
): Promise<{ success: string[]; failed: Array<{ schema: string; error: unknown }> }> {
  const tenants = await listTenantSchemas(sqlClient);
  const maxConcurrency = options.maxConcurrency ?? 5;

  const results: { success: string[]; failed: Array<{ schema: string; error: unknown }> } = {
    success: [],
    failed: [],
  };

  // Process tenants in batches
  for (let i = 0; i < tenants.length; i += maxConcurrency) {
    const batch = tenants.slice(i, i + maxConcurrency);

    await Promise.all(
      batch.map(async (tenant) => {
        try {
          await applyTenantMigrations(sqlClient, tenant.schemaName);
          results.success.push(tenant.schemaName);
        } catch (error) {
          results.failed.push({ schema: tenant.schemaName, error });
        }
      }),
    );
  }

  return results;
}
