/**
 * Tenant migration 76 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration076(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".event_log
        ADD COLUMN IF NOT EXISTS envelope JSONB NOT NULL DEFAULT '{}'::jsonb;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (76, 'Plan 146 — event_log.envelope jsonb column for full SessionEvent body')
      ON CONFLICT (version) DO NOTHING;
    `);
}
