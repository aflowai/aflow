/**
 * Tenant migration 74 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration074(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE INDEX IF NOT EXISTS waiters_session_pending
        ON "${schemaName}".workflow_run_waiters (waiter_session_id)
        WHERE notified_at IS NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (74, 'Plan 135 — partial index on workflow_run_waiters(waiter_session_id) for session-scoped catch-up')
      ON CONFLICT (version) DO NOTHING;
    `);
}
