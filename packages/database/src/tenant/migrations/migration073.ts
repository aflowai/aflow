/**
 * Tenant migration 73 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration073(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_run_tasks
        ADD COLUMN IF NOT EXISTS operation_id TEXT;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (73, 'Plan 135 — workflow_run_tasks.operation_id column for surface detail DTO')
      ON CONFLICT (version) DO NOTHING;
    `);
}
