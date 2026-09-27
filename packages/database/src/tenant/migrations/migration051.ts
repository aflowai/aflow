/**
 * Tenant migration 51 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration051(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_run_tasks
        ADD COLUMN IF NOT EXISTS reflection_json JSONB;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (51, 'Plan 104b Phase 3 — workflow_run_tasks.reflection_json column')
      ON CONFLICT (version) DO NOTHING;
    `);
}
