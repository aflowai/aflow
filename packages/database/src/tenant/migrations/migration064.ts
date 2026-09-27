/**
 * Tenant migration 64 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration064(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE INDEX IF NOT EXISTS workflow_runs_space_completed_terminal_idx
        ON "${schemaName}".workflow_runs (space_id, completed_at DESC)
        WHERE status IN ('completed', 'failed', 'cancelled');
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (64, 'Plan 102m — Partial index for recently-terminal workflow runs')
      ON CONFLICT (version) DO NOTHING;
    `);
}
