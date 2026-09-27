import type postgres from 'postgres';

/**
 * Plan 222 P1 — re-key repo_bindings by repo coordinate.
 *
 * The operator-invented `repo_binding_id` and the raw `remote_url`/`name` columns
 * are replaced by an opaque surrogate (`repo_designation_id`) plus a canonical,
 * host-qualified `coordinate` (e.g. `github.com/owner/repo`) that the agent and
 * skills reference directly. The clone remote is derived from the coordinate, so
 * no raw remote string is stored. Clean cut: any existing arbitrary-id rows are
 * dropped (no coordinate to migrate them to).
 */
export async function applyMigration127(
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
      VALUES (127, 'Plan 222 P1 — re-key repo_bindings by repo coordinate (surrogate id + host-qualified coordinate)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
