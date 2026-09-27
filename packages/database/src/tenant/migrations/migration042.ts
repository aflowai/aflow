/**
 * Tenant migration 42 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration042(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"mcp.server","accessMode":"read"},{"capabilityGroupId":"mcp.server","accessMode":"write"},{"capabilityGroupId":"mcp.binding","accessMode":"read"},{"capabilityGroupId":"mcp.binding","accessMode":"write"},{"capabilityGroupId":"mcp.tool","accessMode":"read"},{"capabilityGroupId":"mcp.tool","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role IN ('admin', 'editor')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"mcp.server"}]'::jsonb);
    `);

  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"mcp.server","accessMode":"read"},{"capabilityGroupId":"mcp.binding","accessMode":"read"},{"capabilityGroupId":"mcp.tool","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role = 'viewer'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"mcp.server"}]'::jsonb);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (42, 'Plan 103 — MCP capability groups in system profiles')
      ON CONFLICT (version) DO NOTHING;
    `);
}
