/**
 * Tenant migration 53 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration053(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS initiated_by_user_id UUID;
  
      CREATE INDEX IF NOT EXISTS workflow_runs_user_skill_running_idx
        ON "${schemaName}".workflow_runs (workflow_slug, initiated_by_user_id)
        WHERE status = 'running';
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (53, 'Plan 104d Phase 3 — initiated_by_user_id + partial index for perUserSerial')
      ON CONFLICT (version) DO NOTHING;
    `);
}
