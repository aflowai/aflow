import type postgres from 'postgres';

export async function applyMigration160(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"eval.dataset","accessMode":"read"},
          {"capabilityGroupId":"eval.case","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"eval.case","accessMode":"write"}]'::jsonb);

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"eval.dataset","accessMode":"read"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Read Only'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"eval.dataset","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (160, 'Plan 269 D7 — eval.dataset (read) + eval.case (write) capability groups in system profiles')
      ON CONFLICT (version) DO NOTHING;
    `);
}
