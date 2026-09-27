/**
 * Tenant schema lifecycle — create, drop, list.
 */
import type postgres from 'postgres';
import { type TenantId } from '@aflow/schemas';
import {
  tenantIdToSchemaName,
  schemaNameToTenantId,
  isValidSchemaName,
  type TenantContext,
} from './context.js';
import { applyTenantMigrations } from './migrations/apply.js';
import { clearTenantDue } from '../repositories/tenantDue.js';
import { TENANT_DUE_POINTERS } from './duePointers.js';

/**
 * Create a new tenant schema with all required tables.
 * This should be called when a new tenant is provisioned.
 */
export async function createTenantSchema(
  sqlClient: postgres.Sql,
  tenantId: TenantId,
): Promise<TenantContext> {
  const schemaName = tenantIdToSchemaName(tenantId);

  // Use raw SQL for schema creation (DDL)
  await sqlClient.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

  // Apply tenant schema migrations
  await applyTenantMigrations(sqlClient, schemaName);

  return { tenantId, schemaName };
}

/**
 * Drop a tenant schema and all its data.
 * WARNING: This is destructive and irreversible.
 */
export async function dropTenantSchema(sqlClient: postgres.Sql, tenantId: TenantId): Promise<void> {
  const schemaName = tenantIdToSchemaName(tenantId);

  // Safety check: only drop schemas with our prefix
  if (!isValidSchemaName(schemaName)) {
    throw new Error(`Refusing to drop invalid schema name: ${schemaName}`);
  }

  // Before the schema goes: due pointers live in `public`, so nothing inside
  // the schema can reach them, and one left behind is claimed and re-claimed
  // against tables that no longer exist.
  await clearTenantDue(sqlClient, TENANT_DUE_POINTERS, tenantId);

  await sqlClient.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
}

/**
 * Check if a tenant schema exists.
 */
export async function tenantSchemaExists(
  sqlClient: postgres.Sql,
  tenantId: TenantId,
): Promise<boolean> {
  const schemaName = tenantIdToSchemaName(tenantId);

  const result = await sqlClient`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.schemata 
      WHERE schema_name = ${schemaName}
    ) as exists
  `;

  const row = result[0] as { exists: boolean } | undefined;
  return row?.exists === true;
}

/**
 * List all tenant schemas.
 */
export async function listTenantSchemas(sqlClient: postgres.Sql): Promise<TenantContext[]> {
  const result = await sqlClient`
    SELECT schema_name 
    FROM information_schema.schemata 
    WHERE schema_name LIKE 't_%'
    ORDER BY schema_name
  `;

  return result
    .filter((row) => {
      const typedRow = row as { schema_name: string };
      return isValidSchemaName(typedRow.schema_name);
    })
    .map((row) => {
      const typedRow = row as { schema_name: string };
      return {
        schemaName: typedRow.schema_name,
        tenantId: schemaNameToTenantId(typedRow.schema_name),
      };
    });
}
