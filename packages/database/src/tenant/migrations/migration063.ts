/**
 * Tenant migration 63 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration063(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"proposal","accessMode":"read"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"workflow.manage","accessMode":"read"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"proposal","accessMode":"read"}]'::jsonb);
  
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"proposal","accessMode":"write"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"workflow.manage","accessMode":"write"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"proposal","accessMode":"write"}]'::jsonb);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (63, 'Plan 111 follow-up — Add proposal capability group')
      ON CONFLICT (version) DO NOTHING;
    `);
}
