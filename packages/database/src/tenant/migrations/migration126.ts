import type postgres from 'postgres';

export async function applyMigration126(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"code.repo","accessMode":"read"},
          {"capabilityGroupId":"code.repo","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Full Access'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"code.repo","accessMode":"write"}]'::jsonb);

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"code.repo","accessMode":"read"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Standard', 'Read Only')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"code.repo","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (126, 'Plan 219 §1.2 — code.repo capability group in system profiles (Standard read-only; space opt-in is the gate)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
