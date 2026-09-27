/**
 * Tenant migration 81 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration081(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".mcp_oauth_state (
        state            TEXT PRIMARY KEY,
        binding_id       TEXT NOT NULL,
        code_verifier    TEXT NOT NULL,
        redirect_uri     TEXT NOT NULL,
        resource         TEXT,
        scopes_json      JSONB NOT NULL DEFAULT '[]',
        initiator        TEXT NOT NULL,
        expires_at       TIMESTAMPTZ NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE INDEX IF NOT EXISTS idx_mcp_oauth_state_binding
        ON "${schemaName}".mcp_oauth_state (binding_id);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (81, 'Plan 103 Phase 0 — mcp_oauth_state table for OAuth 2.1 PKCE consent flow')
      ON CONFLICT (version) DO NOTHING;
    `);
}
