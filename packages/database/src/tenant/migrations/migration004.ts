/**
 * Tenant migration 4 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration004(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // v1 memory_entry_embeddings requires pgvector; probe rather than attempt +
  // swallow, so a real failure (permissions, connection) still propagates.
  // On a database where no tenant has enabled pgvector yet this legitimately
  // finds nothing — migration006 (later in this same run) is the one that
  // calls `CREATE EXTENSION`, so migration148 is what finishes this table for
  // that first-ever-tenant case; here we only handle the common case where
  // pgvector is already enabled database-wide from a prior tenant.
  const extension = await sqlClient.unsafe(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
  if ((extension as unknown as unknown[]).length > 0) {
    // embedding has no fixed dimension — one row's width varies by
    // embedding_model — and pgvector's hnsw index method refuses a column
    // without a fixed dimension, so no vector index is attempted here.
    await sqlClient.unsafe(`
        CREATE TABLE IF NOT EXISTS "${schemaName}".memory_entry_embeddings (
          entry_id UUID NOT NULL REFERENCES "${schemaName}".memory_entries(id) ON DELETE CASCADE,
          embedding_model TEXT NOT NULL,
          dims INTEGER NOT NULL,
          embedding vector NOT NULL,
          content_hash TEXT NOT NULL,
          embedded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (entry_id, embedding_model)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_entry_embeddings_model
          ON "${schemaName}".memory_entry_embeddings (embedding_model, entry_id);
      `);
  }

  // Migration 4: memory_chunks core table (no vector dependency).
  // This creates the table WITHOUT the `embedding vector` column so it works
  // even when pgvector is not installed.  Vector column is added separately.
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".memory_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doc_id UUID NOT NULL REFERENCES "${schemaName}".memory_docs(id) ON DELETE CASCADE,
        doc_version_id UUID NOT NULL REFERENCES "${schemaName}".memory_doc_versions(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        start_offset INTEGER NOT NULL DEFAULT 0,
        end_offset INTEGER NOT NULL DEFAULT 0,
        embedding_model TEXT,
        dims INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_memory_chunks_doc_version
        ON "${schemaName}".memory_chunks (doc_id, doc_version_id, chunk_index);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (4, 'Memory v2 — chunks table (core, no pgvector)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
