/**
 * Tenant migration 9 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration009(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 9: Memory directories — explicit filesystem-like directory entities
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".memory_dirs (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        path        TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        parent_path TEXT,
        description TEXT,
        metadata    JSONB NOT NULL DEFAULT '{}',
        tags        JSONB NOT NULL DEFAULT '[]',
        space_id    UUID,
        user_id     TEXT,
        agent_id    TEXT,
        session_id  UUID,
        created_by_actor TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at  TIMESTAMPTZ
      );
  
      CREATE INDEX IF NOT EXISTS idx_memory_dirs_parent
        ON "${schemaName}".memory_dirs(parent_path) WHERE deleted_at IS NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (9, 'Memory directories — explicit filesystem-like entities')
      ON CONFLICT (version) DO NOTHING;
    `);
}
