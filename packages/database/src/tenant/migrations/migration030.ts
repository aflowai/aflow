/**
 * Tenant migration 30 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration030(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".memory_chunks
        ADD COLUMN IF NOT EXISTS skip_embedding BOOLEAN NOT NULL DEFAULT false;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (30, 'Plan 14 Phase 4 — skip_embedding flag on memory_chunks')
      ON CONFLICT (version) DO NOTHING
    `);
}
