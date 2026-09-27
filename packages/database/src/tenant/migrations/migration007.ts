/**
 * Tenant migration 7 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration007(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 7: API Definitions + API Bindings (API Executor v2)
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".api_definitions (
        api_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        base_url TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '1',
        definition_json JSONB NOT NULL,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        source TEXT NOT NULL DEFAULT 'custom'
          CHECK (source IN ('platform', 'custom', 'openapi_import')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE INDEX IF NOT EXISTS idx_api_definitions_source
        ON "${schemaName}".api_definitions (source) WHERE enabled = 1;
      CREATE INDEX IF NOT EXISTS idx_api_definitions_tags
        ON "${schemaName}".api_definitions USING GIN (tags) WHERE enabled = 1;
  
      CREATE TABLE IF NOT EXISTS "${schemaName}".api_bindings (
        binding_id TEXT PRIMARY KEY,
        api_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        scope_json JSONB NOT NULL,
        auth_json JSONB NOT NULL,
        egress_policy_json JSONB NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE INDEX IF NOT EXISTS idx_api_bindings_api_id
        ON "${schemaName}".api_bindings (api_id) WHERE enabled = 1;
      CREATE INDEX IF NOT EXISTS idx_api_bindings_scope
        ON "${schemaName}".api_bindings USING GIN (scope_json) WHERE enabled = 1;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (7, 'API Executor v2 — definitions + bindings tables')
      ON CONFLICT (version) DO NOTHING;
    `);
}
