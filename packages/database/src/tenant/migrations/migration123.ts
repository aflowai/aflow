import type postgres from 'postgres';

export async function applyMigration123(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".oauth_tokens (
        integration_kind, resource_key, owner_scope, owner_id,
        access_token_enc, refresh_token_enc, token_type, scopes_json,
        audience, expires_at, obtained_at, updated_at
      )
      SELECT
        'mcp',
        b.server_id,
        b.owner_scope,
        t.credential_owner,
        t.access_token_enc,
        t.refresh_token_enc,
        t.token_type,
        t.scopes_json,
        t.audience,
        t.expires_at,
        t.obtained_at,
        t.updated_at
      FROM "${schemaName}".mcp_oauth_tokens t
      JOIN "${schemaName}".mcp_server_bindings b
        ON b.binding_id = t.binding_id AND b.space_id = t.space_id
      ON CONFLICT (integration_kind, resource_key, owner_scope, owner_id) DO NOTHING;

      DROP TABLE IF EXISTS "${schemaName}".mcp_oauth_tokens;
      DROP TABLE IF EXISTS "${schemaName}".mcp_oauth_state;

      ALTER TABLE "${schemaName}".mcp_server_bindings
        DROP COLUMN IF EXISTS credential_owner_mode;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (123, 'Plan 185 — backfill oauth_tokens from mcp_oauth_tokens, DROP mcp_oauth_* + mcp_server_bindings.credential_owner_mode (removals)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
