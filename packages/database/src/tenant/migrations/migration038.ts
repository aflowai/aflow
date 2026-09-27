/**
 * Tenant migration 38 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration038(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 38: Add semantic_type column to memory_docs for specialized UI rendering.
  // Documents can declare their semantic type (e.g. 'workflow_overview', 'compute_result')
  // so any viewer can render them with the appropriate card component.
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".memory_docs
        ADD COLUMN IF NOT EXISTS semantic_type TEXT;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (38, 'Add semantic_type column to memory_docs')
      ON CONFLICT (version) DO NOTHING;
    `);
}
