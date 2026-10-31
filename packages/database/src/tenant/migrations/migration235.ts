import type postgres from 'postgres';

/**
 * Plan 327: `Full Access` and `Standard` carry `channel.message`; `Read Only`
 * carries its read mode.
 *
 * Granted in every install, used or not. It reaches nothing where the channel
 * lane is absent: the catalog withholds `channel.*` there and dispatch refuses
 * it, so the profile only says what the tenant permits once a channel exists.
 */
export async function applyMigration235(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"channel.message","accessMode":"read"},
          {"capabilityGroupId":"channel.message","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"channel.message","accessMode":"write"}]'::jsonb);

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"channel.message","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Read Only'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"channel.message","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (235, 'Full Access and Standard carry the channel.message capability group; Read Only carries its read mode')
      ON CONFLICT (version) DO NOTHING;
  `);
}
