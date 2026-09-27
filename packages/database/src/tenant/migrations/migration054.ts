/**
 * Tenant migration 54 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration054(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      DO $$ BEGIN
        ALTER TABLE "${schemaName}".sessions
          DROP CONSTRAINT IF EXISTS flow_runs_status_check;
      EXCEPTION WHEN undefined_object THEN NULL;
      END $$;
  
      ALTER TABLE "${schemaName}".sessions
        ADD CONSTRAINT flow_runs_status_check
        CHECK (status IN ('QUEUED', 'RUNNING', 'PAUSED', 'WAITING_ON_CHILD', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELLING', 'STALLED'));
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (54, 'Plan 104d follow-up — allow WAITING_ON_CHILD in sessions.status')
      ON CONFLICT (version) DO NOTHING;
    `);
}
