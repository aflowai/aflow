/**
 * Tenant migration 27 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration027(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Add integration.webhook.read + integration.webhook.write to Full Access profile
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"integration.webhook.read","accessMode":"read"},{"capabilityGroupId":"integration.webhook.write","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role = 'admin'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"integration.webhook.read"}]'::jsonb)
    `);

  // Add integration.webhook.read to Standard profile (editors can read but not create)
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"integration.webhook.read","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role = 'editor'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"integration.webhook.read"}]'::jsonb)
    `);

  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (27, 'Plan 78 — Add webhook capabilities to system profiles')
      ON CONFLICT (version) DO NOTHING
    `);

  // ---------------------------------------------------------------------------
}
