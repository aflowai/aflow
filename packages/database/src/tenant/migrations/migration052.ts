/**
 * Tenant migration 52 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration052(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS scheduler_cursor_deadline TIMESTAMPTZ;
  
      ALTER TABLE "${schemaName}".workflow_run_tasks
        ADD COLUMN IF NOT EXISTS step_execution_id TEXT;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (52, 'Plan 104d Phase 1 — scheduler_cursor_deadline + step_execution_id columns')
      ON CONFLICT (version) DO NOTHING;
    `);
}
