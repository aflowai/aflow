import type postgres from 'postgres';

export async function applyMigration116(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"workflow.campaign","accessMode":"read"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"workflow.manage","accessMode":"read"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"workflow.campaign","accessMode":"read"}]'::jsonb);

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"workflow.campaign","accessMode":"write"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"workflow.manage","accessMode":"write"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"workflow.campaign","accessMode":"write"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (116, 'Plan 195 §4.5 — Add workflow.campaign capability group')
      ON CONFLICT (version) DO NOTHING;
    `);
}
