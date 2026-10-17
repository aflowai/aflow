import type postgres from 'postgres';

/**
 * The `model.runtime` capability group (Plan 323 P3b): Helmsman reads the
 * model runtime on this computer and proposes changes to it, each one approved
 * by the operator on a card before it runs. Every system profile that authors
 * takes read and write — the approval, not the profile, is what lets a change
 * through — and `Read Only` takes read.
 */
export async function applyMigration220(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"model.runtime","accessMode":"read"},
          {"capabilityGroupId":"model.runtime","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard', 'Personal Safe')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"model.runtime","accessMode":"write"}]'::jsonb);

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"model.runtime","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Read Only'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"model.runtime","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (220, 'Plan 323 P3b — the model.runtime capability group')
      ON CONFLICT (version) DO NOTHING;
  `);
}
