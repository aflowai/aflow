/**
 * Tenant migration 93 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration093(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".ui_artifacts
        ADD COLUMN IF NOT EXISTS bundle_artifact_key TEXT;
  
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ui_artifacts_bundle_key
        ON "${schemaName}".ui_artifacts (space_id, bundle_artifact_key)
        WHERE bundle_artifact_key IS NOT NULL AND deleted_at IS NULL;
  
      ALTER TABLE "${schemaName}".ui_artifact_versions
        ADD COLUMN IF NOT EXISTS sample_data JSONB;
  
      ALTER TABLE "${schemaName}".ui_artifact_versions
        ADD COLUMN IF NOT EXISTS sample_data_payload_ref TEXT;
  
      CREATE TABLE IF NOT EXISTS "${schemaName}".artifact_bindings (
        space_id              UUID NOT NULL,
        bundle_id             TEXT NOT NULL,
        binding_id            TEXT NOT NULL,
        artifact_id           UUID NOT NULL REFERENCES "${schemaName}".ui_artifacts(id),
        bundle_artifact_key   TEXT NOT NULL,
        enabled               BOOLEAN NOT NULL DEFAULT TRUE,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (space_id, bundle_id, binding_id)
      );
  
      CREATE INDEX IF NOT EXISTS idx_artifact_bindings_artifact
        ON "${schemaName}".artifact_bindings (artifact_id);
  
      CREATE INDEX IF NOT EXISTS idx_artifact_bindings_bundle_key
        ON "${schemaName}".artifact_bindings (space_id, bundle_artifact_key);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (93, 'Plan 158 Phase 0 — bundle_artifact_key, sample_data, artifact_bindings table')
      ON CONFLICT (version) DO NOTHING;
    `);
}
