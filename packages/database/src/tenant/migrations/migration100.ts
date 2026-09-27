import type postgres from 'postgres';

export async function applyMigration100(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"artifact.inspect","accessMode":"read"}]'::jsonb
      WHERE allowed_capabilities @> '[{"capabilityGroupId":"workflow.manage","accessMode":"read"}]'::jsonb
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"artifact.inspect","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (100, 'Plan 163 §10 — Add artifact.inspect capability group')
      ON CONFLICT (version) DO NOTHING;
    `);
}
