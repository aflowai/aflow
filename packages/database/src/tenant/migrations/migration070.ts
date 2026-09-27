/**
 * Tenant migration 70 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration070(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS paused_reason TEXT,
        ADD COLUMN IF NOT EXISTS paused_payload_ref TEXT,
        ADD COLUMN IF NOT EXISTS pause_version INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS resume_claim_token TEXT,
        ADD COLUMN IF NOT EXISTS resume_claim_expires_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS resume_attempt_count INTEGER NOT NULL DEFAULT 0;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (70, 'Plan 130 — workflow_runs pause cause + lease-based resume CAS columns')
      ON CONFLICT (version) DO NOTHING;
    `);
}
