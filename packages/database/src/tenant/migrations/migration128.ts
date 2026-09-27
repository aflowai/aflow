import type postgres from 'postgres';

/**
 * Plan 222 P3a — repo designations resolve through a GitHub connection.
 *
 * `repo_bindings` gains `connection_binding_id` (NOT NULL): the app-level
 * reference to the `api_bindings` row that IS the GitHub connection — the
 * github API definition the coding skills call, and (on the fallback path) the
 * git credential. `credential_key` stays nullable but is now an OPTIONAL
 * per-repo git override, not the sole source. Clean drop+recreate (mirrors 127
 * + the new column); any existing rows are dropped (no connection to migrate
 * them to — per the project's no-backward-compat rule).
 */
export async function applyMigration128(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      DROP TABLE IF EXISTS "${schemaName}".repo_bindings;

      CREATE TABLE "${schemaName}".repo_bindings (
        repo_designation_id text NOT NULL,
        space_id uuid NOT NULL,
        coordinate text NOT NULL,
        description text,
        default_branch text NOT NULL,
        allowed_push_branch_patterns jsonb NOT NULL DEFAULT '[]'::jsonb,
        egress_hosts jsonb NOT NULL DEFAULT '[]'::jsonb,
        check_profiles_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        connection_binding_id text NOT NULL,
        credential_key text,
        status text NOT NULL DEFAULT 'provisioning',
        last_validated_at timestamptz,
        last_error_at timestamptz,
        last_error_code text,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (repo_designation_id, space_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_repo_bindings_coordinate
        ON "${schemaName}".repo_bindings (space_id, coordinate);

      CREATE INDEX IF NOT EXISTS idx_repo_bindings_space
        ON "${schemaName}".repo_bindings (space_id);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (128, 'Plan 222 P3a — repo_bindings.connection_binding_id (resolve repo through a GitHub connection)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
