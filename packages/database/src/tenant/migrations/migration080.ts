/**
 * Tenant migration 80 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration080(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".mcp_oauth_tokens (
        binding_id         TEXT NOT NULL,
        credential_owner   TEXT NOT NULL,
        access_token_enc   TEXT NOT NULL,
        refresh_token_enc  TEXT,
        token_type         TEXT NOT NULL DEFAULT 'Bearer',
        scopes_json        JSONB NOT NULL DEFAULT '[]',
        audience           TEXT,
        expires_at         TIMESTAMPTZ NOT NULL,
        obtained_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (binding_id, credential_owner)
      );
  
      CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_binding
        ON "${schemaName}".mcp_oauth_tokens (binding_id);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (80, 'Plan 103 Phase 0 — mcp_oauth_tokens table (composite PK for per-user tokens)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
