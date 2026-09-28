import type postgres from 'postgres';

/**
 * Every system profile carries `ai.decision:read`. A decision step is a
 * workflow primitive like `ai.text`, and a profile without the group refuses
 * the step at scheduling in any skill that routes on one.
 */
export async function applyMigration210(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"ai.decision","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard', 'Personal Safe', 'Read Only')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"ai.decision","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (210, 'System profiles carry the ai.decision capability group')
      ON CONFLICT (version) DO NOTHING;
  `);
}
