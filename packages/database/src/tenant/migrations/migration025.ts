/**
 * Tenant migration 25 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration025(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".spaces
        ADD COLUMN IF NOT EXISTS rules JSONB NOT NULL DEFAULT '[]'
    `);
  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (25, 'Plan 77 — Add rules column to spaces for agent SpaceContext')
      ON CONFLICT (version) DO NOTHING
    `);

  // ---------------------------------------------------------------------------
}
