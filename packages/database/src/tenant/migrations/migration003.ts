/**
 * Tenant migration 3 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration003(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- Migration 3: Memory v2 — repo-like document store
      CREATE TABLE IF NOT EXISTS "${schemaName}".memory_docs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        path TEXT NOT NULL UNIQUE,
        doc_type TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'text/plain',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT,
        inline_content TEXT,
        payload_ref TEXT,
        preview TEXT,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        summary TEXT,
        space_id UUID,
        user_id TEXT,
        agent_id TEXT,
        session_id UUID,
        created_by_actor TEXT,
        created_by_session_id UUID,
        created_by_step_id TEXT,
        created_by_step_execution_id UUID,
        current_version INTEGER NOT NULL DEFAULT 1,
        embedding_status TEXT NOT NULL DEFAULT 'disabled'
          CHECK (embedding_status IN ('disabled', 'pending', 'indexed', 'failed')),
        indexing_mode TEXT NOT NULL DEFAULT 'auto'
          CHECK (indexing_mode IN ('auto', 'disabled', 'force')),
        expires_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE INDEX IF NOT EXISTS idx_memory_docs_path_prefix
        ON "${schemaName}".memory_docs (path text_pattern_ops)
        WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_docs_space_updated
        ON "${schemaName}".memory_docs (space_id, updated_at DESC)
        WHERE deleted_at IS NULL AND space_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_docs_doc_type_updated
        ON "${schemaName}".memory_docs (doc_type, updated_at DESC)
        WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_docs_tags
        ON "${schemaName}".memory_docs USING GIN (tags)
        WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_docs_expires
        ON "${schemaName}".memory_docs (expires_at)
        WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_docs_session_id
        ON "${schemaName}".memory_docs (session_id)
        WHERE session_id IS NOT NULL AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_docs_agent_id
        ON "${schemaName}".memory_docs (agent_id)
        WHERE agent_id IS NOT NULL AND deleted_at IS NULL;
  
      CREATE TABLE IF NOT EXISTS "${schemaName}".memory_doc_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doc_id UUID NOT NULL REFERENCES "${schemaName}".memory_docs(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        inline_content TEXT,
        payload_ref TEXT,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_by_actor TEXT,
        created_by_session_id UUID,
        created_by_step_execution_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (doc_id, version)
      );
  
      CREATE INDEX IF NOT EXISTS idx_memory_doc_versions_doc
        ON "${schemaName}".memory_doc_versions (doc_id, version DESC);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (3, 'Memory v2 — repo-like document store with versioning and chunks')
      ON CONFLICT (version) DO NOTHING;
    `);
}
