/**
 * Tenant migration 65 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration065(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities || '[{"capabilityGroupId":"capability.registry","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role IN ('admin', 'editor', 'viewer')
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'capability.registry'
        );
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (65, 'Plan 120 — capability.registry capability group')
      ON CONFLICT (version) DO NOTHING;
    `);
}
