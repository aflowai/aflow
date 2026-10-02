import type postgres from 'postgres';

/**
 * `Full Access` and `Standard` carry `browser.page`; `Read Only` carries its
 * read mode.
 *
 * What bounds a browser operation is the profile on the operator's machine —
 * which spaces may use it, and what its posture lets an action do. The profile
 * here is the tenant's own ceiling over that, and Read Only keeps to reading.
 */
export async function applyMigration215(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"browser.page","accessMode":"read"},
          {"capabilityGroupId":"browser.page","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"browser.page","accessMode":"write"}]'::jsonb);

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"browser.page","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Read Only'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"browser.page","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (215, 'Full Access and Standard carry the browser.page capability group; Read Only carries its read mode')
      ON CONFLICT (version) DO NOTHING;
  `);
}
