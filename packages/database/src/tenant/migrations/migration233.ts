import type postgres from 'postgres';

export async function applyMigration233(client: postgres.Sql, schema: string): Promise<void> {
  await client.unsafe(`
    ALTER TABLE "${schema}".mcp_server_definitions
      ADD COLUMN IF NOT EXISTS private_network_json JSONB;
    INSERT INTO "${schema}".schema_migrations (version, description)
    VALUES (233, 'Plan 336 — MCP private network acknowledgment')
    ON CONFLICT (version) DO NOTHING;
  `);
}
