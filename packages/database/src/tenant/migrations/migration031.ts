/**
 * Tenant migration 31 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration031(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- Full Access + Standard: add plan.read and plan.write
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities || '[{"capabilityGroupId":"plan.read","accessMode":"read"},{"capabilityGroupId":"plan.write","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard')
        AND NOT (allowed_capabilities::text LIKE '%plan.read%');
  
      -- Read Only: add plan.read only
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities || '[{"capabilityGroupId":"plan.read","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Read Only'
        AND NOT (allowed_capabilities::text LIKE '%plan.read%');
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (31, 'Plan 88 — Add plan capabilities to system profiles')
      ON CONFLICT (version) DO NOTHING;
    `);
}
