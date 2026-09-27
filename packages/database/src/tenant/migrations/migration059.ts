/**
 * Tenant migration 59 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration059(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 59: Fix migration 58 — role names are admin/editor/viewer, not full_access/standard/read_only
  await sqlClient.unsafe(`
      -- Fix: re-run the capability additions with correct role names
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities || '[{"capabilityGroupId":"skill.compose","accessMode":"read"},{"capabilityGroupId":"skill.compose","accessMode":"write"},{"capabilityGroupId":"capability.binding","accessMode":"read"},{"capabilityGroupId":"capability.binding","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role IN ('admin', 'editor')
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'skill.compose'
        );
  
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities || '[{"capabilityGroupId":"skill.compose","accessMode":"read"},{"capabilityGroupId":"capability.binding","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role = 'viewer'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'skill.compose'
        );
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (59, 'Fix migration 58 — correct role names for capability profiles')
      ON CONFLICT (version) DO NOTHING;
    `);
}
