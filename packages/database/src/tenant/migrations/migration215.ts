import type postgres from 'postgres';

/**
 * `Full Access` and `Standard` carry `browser.page` and `browser.profile`;
 * `Read Only` carries neither.
 *
 * Loading a page runs its scripts with the operator's sign-ins, so opening one
 * is a write, and every observation needs a page opened first. A read grant
 * alone would offer the operations that look at a page and none that can make
 * one. What bounds a browser operation past this is the profile on the
 * operator's machine — which spaces may use it, and what its posture lets an
 * action do.
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
          {"capabilityGroupId":"browser.page","accessMode":"write"},
          {"capabilityGroupId":"browser.profile","accessMode":"read"},
          {"capabilityGroupId":"browser.profile","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"browser.page","accessMode":"write"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (215, 'Full Access and Standard carry the browser.page and browser.profile capability groups')
      ON CONFLICT (version) DO NOTHING;
  `);
}
