/**
 * Repairs the collateral damage of migrations 4 and 6: both bundled a
 * doomed HNSW index statement into the same `unsafe()` call as their
 * CREATE TABLE / ADD COLUMN — a dimension-less `embedding` column can't
 * build an hnsw index at all, and `embedding_3072` exceeds pgvector's
 * 2000-dimension hnsw cap — so Postgres's implicit-transaction-per-simple-
 * query rolled the whole batch back, including the parts that would have
 * succeeded. Both migrations still recorded themselves as applied, and
 * `apply.ts` never re-runs a recorded version, so this is the only path
 * back to a healed tenant. Runs in POST_TAXONOMY (always attempted) so it
 * both repairs already-migrated tenants and finishes the table for a
 * brand-new tenant on the very first database pgvector is enabled in
 * (where migration004 ran before migration006 had created the extension).
 */
import type postgres from 'postgres';

export async function applyMigration148(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  const extension = await sqlClient.unsafe(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
  if ((extension as unknown as unknown[]).length === 0) {
    // Genuinely absent (local dev only — production always installs pgvector).
    // Deliberately NOT recorded as applied: `apply.ts` skips any version
    // already in schema_migrations, so recording here would permanently
    // suppress the repair on a tenant that enables pgvector later — the same
    // "recorded but the work never happened" bug this migration exists to fix.
    // Leaving it unrecorded means the next `yarn db:migrate` retries it.
    console.warn(`[tenant] Migration 148 skipped — pgvector not installed on this Postgres.`);
    return;
  }

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
    `);
  await sqlClient.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_memory_entry_embeddings_model
        ON "${schemaName}".memory_entry_embeddings (embedding_model, entry_id);
    `);
  // No hnsw index on `embedding` — it has no fixed dimension by design (rows
  // mix embedding_model/dims), and pgvector's hnsw refuses a column without
  // one ("column does not have dimensions"). This can never succeed.

  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".memory_chunks
        ADD COLUMN IF NOT EXISTS embedding_1536 vector(1536);
    `);
  await sqlClient.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_vec_1536
        ON "${schemaName}".memory_chunks
        USING hnsw (embedding_1536 vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
        WHERE embedding_1536 IS NOT NULL;
    `);
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".memory_chunks
        ADD COLUMN IF NOT EXISTS embedding_3072 vector(3072);
    `);
  // No hnsw index on embedding_3072 — pgvector hard-caps hnsw/ivfflat at 2000
  // dimensions ("column cannot have more than 2000 dimensions for hnsw
  // index"). Sequential scan is the accepted cost until a halfvec migration.

  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (148, 'Repair migration004/006 pgvector collateral damage — memory_entry_embeddings table + embedding_3072 column')
      ON CONFLICT (version) DO NOTHING;
    `);
}
