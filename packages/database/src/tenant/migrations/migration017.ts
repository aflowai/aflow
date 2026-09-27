/**
 * Tenant migration 17 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration017(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".event_log
        ADD COLUMN IF NOT EXISTS operation_id TEXT;
  
      -- Composite index for operation-scoped queries:
      -- "find all StepSucceeded events for operation X, newest first"
      -- Partial index on StepSucceeded keeps it small — only step-outcome events need this.
      CREATE INDEX IF NOT EXISTS idx_event_log_operation_succeeded
        ON "${schemaName}".event_log (operation_id, timestamp DESC)
        WHERE event_type = 'StepSucceeded' AND operation_id IS NOT NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (17, 'Add operation_id to event_log for operation-scoped queries')
      ON CONFLICT (version) DO NOTHING;
    `);
}
