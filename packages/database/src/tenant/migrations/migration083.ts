/**
 * Tenant migration 83 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration083(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"mcp.sampling","accessMode":"write"},{"capabilityGroupId":"mcp.resource","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role IN ('admin', 'editor')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"mcp.sampling"}]'::jsonb);
    `);

  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"mcp.resource","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role = 'viewer'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"mcp.resource"}]'::jsonb);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (83, 'Plan 103 Phase 0 — mcp.sampling + mcp.resource capability groups in system profiles')
      ON CONFLICT (version) DO NOTHING;
    `);
}
