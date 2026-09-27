/**
 * Tenant migration 58 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration058(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- Full Access + Standard (admin + editor): add skill.compose + capability.binding (read+write)
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities || '[{"capabilityGroupId":"skill.compose","accessMode":"read"},{"capabilityGroupId":"skill.compose","accessMode":"write"},{"capabilityGroupId":"capability.binding","accessMode":"read"},{"capabilityGroupId":"capability.binding","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role IN ('admin', 'editor')
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'skill.compose'
        );
  
      -- Read Only (viewer): add skill.compose + capability.binding (read only)
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities || '[{"capabilityGroupId":"skill.compose","accessMode":"read"},{"capabilityGroupId":"capability.binding","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role = 'viewer'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'skill.compose'
        );
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (58, 'Plan 104f/104g — skill.compose + capability.binding capabilities')
      ON CONFLICT (version) DO NOTHING;
    `);
}
