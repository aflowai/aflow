/**
 * Tenant migration 40 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration040(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".mcp_server_definitions (
        server_id       TEXT NOT NULL,
        name            TEXT NOT NULL,
        description     TEXT,
        server_url      TEXT NOT NULL,
        transport       TEXT NOT NULL DEFAULT 'streamable_http',
        definition_json JSONB NOT NULL,
        tags            JSONB NOT NULL DEFAULT '[]',
        source          TEXT NOT NULL DEFAULT 'custom',
        enabled         INT NOT NULL DEFAULT 1,
        space_id        UUID NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (server_id, space_id)
      );
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (40, 'Plan 103 — MCP server definitions table')
      ON CONFLICT (version) DO NOTHING;
    `);

  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".mcp_server_bindings (
        binding_id              TEXT PRIMARY KEY,
        server_id               TEXT NOT NULL,
        name                    TEXT NOT NULL,
        description             TEXT,
        scope_json              JSONB NOT NULL,
        auth_json               JSONB NOT NULL,
        connection_policy_json  JSONB NOT NULL DEFAULT '{}',
        pinned_origin           TEXT,
        cached_tools            JSONB,
        cached_tools_at         TIMESTAMPTZ,
        enabled                 INT NOT NULL DEFAULT 1,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (41, 'Plan 103 — MCP server bindings table')
      ON CONFLICT (version) DO NOTHING;
    `);
}
