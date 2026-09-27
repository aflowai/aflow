/**
 * Tenant migration 77 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration077(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_run_tasks
        ADD COLUMN IF NOT EXISTS error_code TEXT,
        ADD COLUMN IF NOT EXISTS error_classification TEXT,
        ADD COLUMN IF NOT EXISTS error_retryable BOOLEAN,
        ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS prior_failures JSONB NOT NULL DEFAULT '[]'::jsonb;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (77, 'Plan 149 Phase 1.5 — failure metadata on workflow_run_tasks (error_code, error_classification, error_retryable, failed_at, prior_failures)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
