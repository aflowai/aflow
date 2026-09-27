/**
 * Tenant migration 39 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration039(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".spaces
        ADD COLUMN IF NOT EXISTS directives JSONB DEFAULT NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (39, 'Plan 102d — Add directives column to spaces for cybernetic entity governance')
      ON CONFLICT (version) DO NOTHING;
    `);
}
