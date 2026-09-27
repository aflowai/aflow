/**
 * Tenant migration 68 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration068(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- admin + editor: skill.manage read+write
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities ||
        '[{"capabilityGroupId":"skill.manage","accessMode":"read"},{"capabilityGroupId":"skill.manage","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role IN ('admin', 'editor')
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'skill.manage'
        );
  
      -- viewer: skill.manage read only (so preview works)
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities ||
        '[{"capabilityGroupId":"skill.manage","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role = 'viewer'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'skill.manage'
        );
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (68, 'Plan 119 — skill.manage capability group for archive/unarchive/purge/preview')
      ON CONFLICT (version) DO NOTHING;
    `);
}
