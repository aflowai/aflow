import type postgres from 'postgres';

/**
 * The `ai.model` capability group (Plan 315): `ai.model.probe_reasoning`
 * measures a catalog model's reasoning ladder with the space's stored provider
 * credential. Full Access, Standard and Personal Safe take read and write;
 * Read Only takes read, as every new group does.
 */
export async function applyMigration228(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"ai.model","accessMode":"read"},
          {"capabilityGroupId":"ai.model","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard', 'Personal Safe')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"ai.model","accessMode":"write"}]'::jsonb);

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"ai.model","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Read Only'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"ai.model","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (228, 'Plan 315 — the ai.model capability group')
      ON CONFLICT (version) DO NOTHING;
  `);
}
