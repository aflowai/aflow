/**
 * Tenant migration 87 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration087(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".mcp_server_bindings
        DROP COLUMN IF EXISTS tool_access_policy_json;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (87, 'Plan 103 v2 — tool curation moves to definition; drop mcp_server_bindings.tool_access_policy_json')
      ON CONFLICT (version) DO NOTHING;
    `);
}
