/**
 * Tenant migration 82 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration082(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".mcp_server_definitions
        SET transport = 'streamable_http',
            definition_json = jsonb_set(definition_json, '{transport}', '"streamable_http"'::jsonb, false)
        WHERE transport = 'sse'
           OR definition_json->>'transport' = 'sse';
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (82, 'Plan 103 Phase 0 — drop legacy sse transport (column + definition_json)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
