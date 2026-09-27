/**
 * Tenant migration 49 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration049(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".spaces
        ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'classic';
  
      -- Backfill: set cybernetic for spaces that have directives
      UPDATE "${schemaName}".spaces
        SET mode = 'cybernetic'
        WHERE directives IS NOT NULL AND mode != 'cybernetic';
  
      UPDATE "${schemaName}".spaces
        SET mode = 'classic'
        WHERE directives IS NULL AND mode != 'classic';
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (49, 'Plan 104c — spaces.mode column (classic | cybernetic)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
