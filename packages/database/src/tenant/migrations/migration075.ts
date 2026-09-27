/**
 * Tenant migration 75 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration075(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE INDEX IF NOT EXISTS workflow_run_tasks_worker_session_id_idx
        ON "${schemaName}".workflow_run_tasks (worker_session_id)
        WHERE worker_session_id IS NOT NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (75, 'Plan 140 Phase 7 — partial index on workflow_run_tasks(worker_session_id) for activity relay hook')
      ON CONFLICT (version) DO NOTHING;
    `);
}
