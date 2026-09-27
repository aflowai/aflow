/**
 * Tenant migration 2 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration002(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- Migration 2: Add QUEUED and STALLED to sessions status CHECK constraint
      DO $$ BEGIN
        ALTER TABLE "${schemaName}".sessions
          DROP CONSTRAINT IF EXISTS flow_runs_status_check;
      EXCEPTION WHEN undefined_object THEN NULL;
      END $$;
  
      ALTER TABLE "${schemaName}".sessions
        ADD CONSTRAINT flow_runs_status_check
        CHECK (status IN ('QUEUED', 'RUNNING', 'PAUSED', 'WAITING_ON_CHILD', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELLING', 'STALLED'));
  
      ALTER TABLE "${schemaName}".sessions
        ALTER COLUMN status SET DEFAULT 'QUEUED';
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (2, 'Add QUEUED and STALLED run statuses')
      ON CONFLICT (version) DO NOTHING;
  
    `);
}
