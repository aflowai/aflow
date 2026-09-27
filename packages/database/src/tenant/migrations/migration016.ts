/**
 * Tenant migration 16 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration016(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".ui_artifacts (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name                        TEXT NOT NULL,
        description                 TEXT,
        kind                        TEXT NOT NULL,
        space_id                    UUID NOT NULL,
        current_version             INTEGER NOT NULL DEFAULT 0,
        catalog_id                  TEXT NOT NULL,
        catalog_version             TEXT NOT NULL,
        catalog_hash                TEXT NOT NULL,
        tags                        JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_by_actor            TEXT,
        created_by_session_id       UUID,
        created_by_step_execution_id UUID,
        deleted_at                  TIMESTAMPTZ,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE INDEX IF NOT EXISTS idx_ui_artifacts_space
        ON "${schemaName}".ui_artifacts (space_id, updated_at DESC)
        WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_ui_artifacts_tags
        ON "${schemaName}".ui_artifacts USING GIN (tags)
        WHERE deleted_at IS NULL;
  
      CREATE TABLE IF NOT EXISTS "${schemaName}".ui_artifact_versions (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        artifact_id                 UUID NOT NULL REFERENCES "${schemaName}".ui_artifacts(id),
        version                     INTEGER NOT NULL,
        source_ref                  TEXT NOT NULL,
        compiled_ref                TEXT NOT NULL,
        html_ref                    TEXT NOT NULL,
        content_hash                TEXT NOT NULL,
        prompt                      TEXT NOT NULL,
        data_schema                 JSONB,
        validation_report           JSONB,
        parent_version_id           UUID,
        created_by_actor            TEXT,
        created_by_session_id       UUID,
        created_by_step_execution_id UUID,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (artifact_id, version)
      );
  
      CREATE INDEX IF NOT EXISTS idx_ui_artifact_versions_artifact
        ON "${schemaName}".ui_artifact_versions (artifact_id, version DESC);
  
      CREATE TABLE IF NOT EXISTS "${schemaName}".ui_artifact_drafts (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        artifact_id                 UUID,
        kind                        TEXT NOT NULL,
        space_id                    UUID NOT NULL,
        prompt                      TEXT NOT NULL,
        source_ref                  TEXT NOT NULL,
        compiled_ref                TEXT,
        html_ref                    TEXT,
        data_schema                 JSONB,
        validation_report           JSONB,
        catalog_id                  TEXT NOT NULL,
        catalog_version             TEXT NOT NULL,
        catalog_hash                TEXT NOT NULL,
        status                      TEXT NOT NULL DEFAULT 'draft',
        created_by_actor            TEXT,
        created_by_session_id       UUID,
        created_by_step_execution_id UUID,
        expires_at                  TIMESTAMPTZ NOT NULL,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE INDEX IF NOT EXISTS idx_ui_artifact_drafts_expires
        ON "${schemaName}".ui_artifact_drafts (expires_at);
      CREATE INDEX IF NOT EXISTS idx_ui_artifact_drafts_space
        ON "${schemaName}".ui_artifact_drafts (space_id, created_at DESC);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (16, 'Plan 43 Phase 3 — UI artifact persistence tables')
      ON CONFLICT (version) DO NOTHING;
    `);
}
