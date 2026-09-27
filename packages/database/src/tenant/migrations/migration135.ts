import type postgres from 'postgres';

export async function applyMigration135(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".store_installs (
        catalog_id text NOT NULL,
        space_id uuid NOT NULL,
        kind text NOT NULL,
        installed_version integer NOT NULL,
        installed_content_hash text NOT NULL,
        skipped_version integer,
        state text NOT NULL DEFAULT 'installed',
        installed_at timestamptz NOT NULL DEFAULT now(),
        installed_by uuid NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by uuid NOT NULL,
        PRIMARY KEY (catalog_id, space_id)
      );

      CREATE INDEX IF NOT EXISTS idx_store_installs_space
        ON "${schemaName}".store_installs (space_id);

      CREATE TABLE IF NOT EXISTS "${schemaName}".store_install_artifacts (
        catalog_id text NOT NULL,
        space_id uuid NOT NULL,
        artifact_type text NOT NULL,
        artifact_key text NOT NULL,
        artifact_id text NOT NULL,
        installed_content_hash text NOT NULL,
        preservation text NOT NULL,
        PRIMARY KEY (catalog_id, space_id, artifact_type, artifact_key)
      );

      CREATE INDEX IF NOT EXISTS idx_store_install_artifacts_space
        ON "${schemaName}".store_install_artifacts (space_id, catalog_id);

      CREATE TABLE IF NOT EXISTS "${schemaName}".store_install_claims (
        catalog_id text NOT NULL,
        space_id uuid NOT NULL,
        claimed_by text NOT NULL,
        PRIMARY KEY (catalog_id, space_id, claimed_by)
      );

      CREATE INDEX IF NOT EXISTS idx_store_install_claims_space
        ON "${schemaName}".store_install_claims (space_id, catalog_id);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (135, 'Plan 244 P0 — store install provenance (store_installs, store_install_artifacts, store_install_claims)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
