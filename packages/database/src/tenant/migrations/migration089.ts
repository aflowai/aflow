/**
 * Tenant migration 89 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration089(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"integration.registry","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"integration.registry","accessMode":"read"}]'::jsonb);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (89, 'Plan 155 §9 — integration.registry:read capability in all system profiles (integration.registry.lookup + list)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
