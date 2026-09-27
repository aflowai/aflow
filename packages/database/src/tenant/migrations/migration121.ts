import type postgres from 'postgres';

export async function applyMigration121(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".repo_bindings (
        repo_binding_id text NOT NULL,
        space_id uuid NOT NULL,
        name text NOT NULL,
        description text,
        remote_url text NOT NULL,
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
        PRIMARY KEY (repo_binding_id, space_id)
      );

      CREATE INDEX IF NOT EXISTS idx_repo_bindings_space
        ON "${schemaName}".repo_bindings (space_id);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (121, 'Plan 219 §0.3 — repo_bindings (space-scoped coding-lane repo authority)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
