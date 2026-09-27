/**
 * Tenant migration 94 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration094(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"ui.surface","accessMode":"read"},{"capabilityGroupId":"ui.surface","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role IN ('admin', 'editor')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"ui.surface"}]'::jsonb);
  
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"ui.surface","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role = 'viewer'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"ui.surface"}]'::jsonb);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (94, 'Plan 158 §4.8 — ui.surface capability group in system profiles')
      ON CONFLICT (version) DO NOTHING;
    `);
}
