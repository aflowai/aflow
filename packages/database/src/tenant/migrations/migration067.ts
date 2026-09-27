/**
 * Tenant migration 67 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration067(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities ||
        '[{"capabilityGroupId":"workflow.lifecycle","accessMode":"read"},{"capabilityGroupId":"workflow.lifecycle","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role IN ('admin', 'editor')
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'workflow.lifecycle'
        );
  
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities ||
        '[{"capabilityGroupId":"workflow.lifecycle","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role = 'viewer'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'workflow.lifecycle'
        );
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (67, 'Plan 123 C4 — workflow.lifecycle capability group')
      ON CONFLICT (version) DO NOTHING;
    `);
}
