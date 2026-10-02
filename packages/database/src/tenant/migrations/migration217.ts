import type postgres from 'postgres';

/**
 * `Personal Safe` carries `browser.page` and `browser.profile`.
 *
 * Migration 215 granted them to `Full Access` and `Standard` alone, and every
 * space on the local edition holds `Personal Safe`, so every browser operation
 * there was refused before it reached the machine. Migrations 195 and 199 met
 * the same thing for the host lane.
 *
 * What bounds a browser operation is the profile on the operator's machine —
 * which spaces may use it, and what its posture lets an action do — not a
 * second, coarser opinion here.
 */
export async function applyMigration217(
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
        AND name = 'Personal Safe'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"browser.page","accessMode":"write"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (217, 'Personal Safe carries the browser.page and browser.profile capability groups')
      ON CONFLICT (version) DO NOTHING;
  `);
}
