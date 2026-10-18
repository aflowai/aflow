import type postgres from 'postgres';

/**
 * Memory embeddings per space (Plan 315 D12).
 *
 * A space has exactly one embedding model, stored on the space, because
 * vectors from two models share no geometry and search must read one of them.
 * A space with embedded chunks is pinned to the model that made the most of
 * them, so its existing index stays searchable, and a document embedded by
 * another model is queued to embed again. `memory_embed_config`, whose
 * path, agent and global scopes nothing wrote, goes.
 *
 * `unconfigured` is a document the embedder could not serve for want of a
 * provider; it is not `pending`, so the backfill does not re-claim it every
 * cadence.
 */
export async function applyMigration221(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".spaces
        ADD COLUMN IF NOT EXISTS memory_embedding_model TEXT;

      ALTER TABLE "${schemaName}".memory_docs
        ADD COLUMN IF NOT EXISTS embedding_error TEXT;

      ALTER TABLE "${schemaName}".memory_docs
        DROP CONSTRAINT IF EXISTS memory_docs_embedding_status_check;
      ALTER TABLE "${schemaName}".memory_docs
        ADD CONSTRAINT memory_docs_embedding_status_check
        CHECK (embedding_status IN ('disabled', 'pending', 'indexed', 'failed', 'unconfigured'));

      UPDATE "${schemaName}".spaces s
      SET memory_embedding_model = c.embedding_model
      FROM "${schemaName}".memory_embed_config c
      WHERE c.scope_type = 'space'
        AND c.scope_value = s.id::text
        AND s.memory_embedding_model IS NULL;

      UPDATE "${schemaName}".spaces s
      SET memory_embedding_model = used.embedding_model
      FROM (
        SELECT DISTINCT ON (d.space_id) d.space_id, c.embedding_model
        FROM "${schemaName}".memory_chunks c
        JOIN "${schemaName}".memory_docs d ON d.id = c.doc_id
        WHERE c.embedding_model IS NOT NULL
        GROUP BY d.space_id, c.embedding_model
        ORDER BY d.space_id, count(*) DESC
      ) used
      WHERE used.space_id = s.id
        AND s.memory_embedding_model IS NULL;

      UPDATE "${schemaName}".memory_docs d
      SET embedding_status = 'pending', updated_at = NOW()
      FROM "${schemaName}".spaces s
      WHERE s.id = d.space_id
        AND d.embedding_status = 'indexed'
        AND EXISTS (
          SELECT 1 FROM "${schemaName}".memory_chunks c
          WHERE c.doc_id = d.id
            AND c.embedding_model IS NOT NULL
            AND c.embedding_model IS DISTINCT FROM s.memory_embedding_model
        );

      DROP TABLE IF EXISTS "${schemaName}".memory_embed_config;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (221, 'Plan 315 D12 — one embedding model per space; unconfigured documents')
      ON CONFLICT (version) DO NOTHING;
  `);
}
