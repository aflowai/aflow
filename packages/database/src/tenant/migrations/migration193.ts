import type postgres from 'postgres';

/**
 * Give the system profiles the host lane's file capability.
 *
 * A capability group with no profile granting it is not "off by default" — it
 * is unreachable, and the error an agent gets says the operation is covered by
 * no allowed capability, which reads like a platform fault rather than a
 * choice. The coding lane made the same trip in migration 120.
 *
 * `Personal Safe` is deliberately absent. It is the profile a fresh local
 * workspace gets, and reaching the operator's own files is not something a
 * workspace should acquire by being created — migration 138 withholds compute
 * and the coding lane from it for the same reason.
 *
 * This grants the capability, not the access. A binding still has to exist, the
 * space policy still has to be on, and the host still has to be paired; the
 * profile only decides whether the operation is addressable at all.
 */
export async function applyMigration193(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"host.file","accessMode":"read"},
          {"capabilityGroupId":"host.file","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Full Access'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"host.file","accessMode":"write"}]'::jsonb);

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"host.file","accessMode":"read"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Standard', 'Read Only')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"host.file","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (193, 'Grant host.file to the system capability profiles')
      ON CONFLICT (version) DO NOTHING;
  `);
}
