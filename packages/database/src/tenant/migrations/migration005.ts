/**
 * Tenant migration 5 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration005(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 5: FTS on memory_chunks — generated tsvector + GIN index.
  // Works without pgvector; enables tsquery-based grep.
  try {
    await sqlClient.unsafe(`
        ALTER TABLE "${schemaName}".memory_chunks
          ADD COLUMN IF NOT EXISTS chunk_tsv tsvector
          GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED;
  
        CREATE INDEX IF NOT EXISTS idx_memory_chunks_fts
          ON "${schemaName}".memory_chunks USING GIN (chunk_tsv);
  
        INSERT INTO "${schemaName}".schema_migrations (version, description)
        VALUES (5, 'Memory v2 Phase 3 — FTS tsvector on memory_chunks')
        ON CONFLICT (version) DO NOTHING;
      `);
  } catch (e) {
    console.warn(
      `[tenant] Migration 5 (FTS) partial — may already exist: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
