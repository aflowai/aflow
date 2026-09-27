/**
 * Tenant migration 66 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration066(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 66: Persist parent_session_id on sessions so the chat session
  // inspector's Map tab can scope skill activations to the current session
  // and its descendants — including completed/failed runs whose Redis hot
  // state has been evicted. Recursive CTE walks the chain at query time.
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".sessions
        ADD COLUMN IF NOT EXISTS parent_session_id UUID;
  
      CREATE INDEX IF NOT EXISTS idx_sessions_parent
        ON "${schemaName}".sessions (parent_session_id)
        WHERE parent_session_id IS NOT NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (66, 'Persist parent_session_id on sessions for cascade scoping')
      ON CONFLICT (version) DO NOTHING;
    `);
}
