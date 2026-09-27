/**
 * Tenant migration 79 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration079(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".mcp_server_bindings
        ADD COLUMN IF NOT EXISTS tool_access_policy_json JSONB;
  
      ALTER TABLE "${schemaName}".mcp_server_bindings
        ADD COLUMN IF NOT EXISTS subscribe_list_changed INT NOT NULL DEFAULT 1;
  
      ALTER TABLE "${schemaName}".mcp_server_bindings
        ADD COLUMN IF NOT EXISTS sampling_policy TEXT NOT NULL DEFAULT 'off';
  
      ALTER TABLE "${schemaName}".mcp_server_bindings
        ADD COLUMN IF NOT EXISTS session_metadata_json JSONB;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (79, 'Plan 103 Phase 0 — extend mcp_server_bindings with tool ACL, list_changed opt-in, sampling policy, session metadata')
      ON CONFLICT (version) DO NOTHING;
    `);
}
