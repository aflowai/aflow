/**
 * Tenant migration 6 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration006(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 6: Per-scope embedding model config table +
  // named embedding columns (embedding_1536, embedding_3072) with individual HNSW indexes.
  // Replaces the old single 'embedding' column.
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".memory_embed_config (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'space', 'flow', 'path_prefix')),
        scope_value TEXT,
        embedding_model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embed_config_scope
        ON "${schemaName}".memory_embed_config (scope_type, scope_value)
        NULLS NOT DISTINCT;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (6, 'Memory v2 — per-scope embedding model config + multi-dim columns')
      ON CONFLICT (version) DO NOTHING;
    `);

  // `pg_available_extensions` reports whether the extension's files are
  // installed on this Postgres server, independent of any per-database
  // privilege — the one legitimate skip (local dev without the extension).
  // A subsequent `CREATE EXTENSION` failure (insufficient privilege,
  // connectivity) is a real error and must propagate, not be swallowed as if
  // it were the "not installed" case — that conflation is exactly the bug
  // this migration exists to fix.
  const available = await sqlClient.unsafe(
    `SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`,
  );
  if ((available as unknown as unknown[]).length === 0) {
    console.warn(`[tenant] Migration 6 pgvector columns skipped: extension not installed.`);
    return;
  }
  await sqlClient.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);

  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".memory_chunks
        ADD COLUMN IF NOT EXISTS embedding_1536 vector(1536);
    `);
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".memory_chunks
        ADD COLUMN IF NOT EXISTS embedding_3072 vector(3072);
    `);

  await sqlClient.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_vec_1536
        ON "${schemaName}".memory_chunks
        USING hnsw (embedding_1536 vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
        WHERE embedding_1536 IS NOT NULL;
    `);
  // embedding_3072 gets no hnsw/ivfflat index — pgvector hard-caps both index
  // methods at 2000 dimensions, so a 3072-dim column can never be ANN-indexed.
  // Cosine search against it sequential-scans; revisit with `halfvec` if that
  // ever becomes a real bottleneck.

  // Drop the old single 'embedding' column — no longer needed
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".memory_chunks
        DROP COLUMN IF EXISTS embedding;
    `);
}
