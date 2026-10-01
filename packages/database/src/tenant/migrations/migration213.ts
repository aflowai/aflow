import type postgres from 'postgres';

/**
 * Every system profile carries `host.binding:read`.
 *
 * `host.binding.inspect` reads what the operator declared about a connected
 * folder — its root, its grants, and when a publication asks before pushing —
 * and touches nothing in the folder. Local Publish reads the push posture
 * through it on every run, so a profile without the group refuses the
 * publication at its first decision. Read Only takes it too: it is a read.
 */
export async function applyMigration213(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"host.binding","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard', 'Personal Safe', 'Read Only')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"host.binding","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (213, 'System profiles carry the host.binding capability group')
      ON CONFLICT (version) DO NOTHING;
  `);
}
