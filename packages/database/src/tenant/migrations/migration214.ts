import type postgres from 'postgres';

/**
 * Every system profile carries `host.commit:read`.
 *
 * `host.commit.scan` reads the lines a range of commits adds in a connected
 * repository and writes nothing. Local Publish scans its own commit through it
 * before every push, so a profile without the group refuses the publication
 * before anything leaves the machine. Read Only takes it too: it is a read.
 *
 * No profile gets `:write` because the group has no write.
 */
export async function applyMigration214(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"host.commit","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard', 'Personal Safe', 'Read Only')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"host.commit","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (214, 'System profiles carry the host.commit capability group')
      ON CONFLICT (version) DO NOTHING;
  `);
}
