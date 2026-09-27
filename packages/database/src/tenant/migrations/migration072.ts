/**
 * Tenant migration 72 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration072(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities ||
        '[{"capabilityGroupId":"workflow.run","accessMode":"read"},{"capabilityGroupId":"workflow.run","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role IN ('admin', 'editor')
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'workflow.run'
        );
  
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities ||
        '[{"capabilityGroupId":"workflow.run","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role = 'viewer'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'workflow.run'
        );
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (72, 'Plan 132v2 Phase 4 — workflow.run capability backfill (start/resume/cancel/detail/list_attention)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
