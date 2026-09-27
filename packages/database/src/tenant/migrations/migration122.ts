import type postgres from 'postgres';

export async function applyMigration122(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".oauth_clients (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        scope                   text NOT NULL CHECK (scope IN ('tenant','space')),
        scope_id                uuid NOT NULL,
        issuer_key              text NOT NULL,
        client_id               text NOT NULL,
        encrypted_client_secret text,
        authorization_server    text,
        default_scopes_json     jsonb NOT NULL DEFAULT '[]',
        label                   text NOT NULL,
        created_by              uuid NOT NULL,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now(),
        UNIQUE (scope, scope_id, issuer_key)
      );

      CREATE TABLE IF NOT EXISTS "${schemaName}".oauth_tokens (
        integration_kind  text NOT NULL CHECK (integration_kind IN ('mcp','api')),
        resource_key      text NOT NULL,
        owner_scope       text NOT NULL CHECK (owner_scope IN ('user','space','tenant')),
        owner_id          text NOT NULL,
        access_token_enc  text NOT NULL,
        refresh_token_enc text,
        token_type        text NOT NULL DEFAULT 'Bearer',
        scopes_json       jsonb NOT NULL DEFAULT '[]',
        audience          text,
        client_id_used    text,
        expires_at        timestamptz NOT NULL,
        obtained_at       timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (integration_kind, resource_key, owner_scope, owner_id)
      );

      CREATE TABLE IF NOT EXISTS "${schemaName}".oauth_state (
        state             text PRIMARY KEY,
        integration_kind  text NOT NULL,
        resource_key      text NOT NULL,
        binding_id        text NOT NULL,
        space_id          uuid NOT NULL,
        owner_scope       text NOT NULL,
        owner_id          text NOT NULL,
        client_scope      text NOT NULL,
        code_verifier     text NOT NULL,
        redirect_uri      text NOT NULL,
        resource          text,
        scopes_json       jsonb NOT NULL DEFAULT '[]',
        expires_at        timestamptz NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now()
      );

      ALTER TABLE "${schemaName}".mcp_server_bindings
        ADD COLUMN IF NOT EXISTS owner_scope text NOT NULL DEFAULT 'tenant';
      ALTER TABLE "${schemaName}".mcp_server_bindings
        ADD COLUMN IF NOT EXISTS client_scope text NOT NULL DEFAULT 'platform';

      UPDATE "${schemaName}".mcp_server_bindings
        SET owner_scope = credential_owner_mode
        WHERE owner_scope IS DISTINCT FROM credential_owner_mode;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (122, 'Plan 185 — unified oauth_clients/oauth_tokens/oauth_state + mcp_server_bindings owner_scope/client_scope (additive)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
