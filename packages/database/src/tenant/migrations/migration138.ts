import type postgres from 'postgres';

/**
 * `Personal Safe` is DERIVED from the live Standard row (not a hand-written
 * list) so it inherits every group Standard has accumulated across
 * migrations, minus the shared-infrastructure execution lanes.
 */
export async function applyMigration138(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      INSERT INTO "${schemaName}".capability_profiles
        (name, description, allowed_capabilities, denied_capabilities, allowed_risk_modifiers, denied_risk_modifiers, allow_privileged, is_default, is_system_profile, default_for_role)
      SELECT
        'Personal Safe',
        'Standard authoring without shared-infrastructure execution: no compute sandbox, no coding lane. Default for member-created spaces.',
        COALESCE((
          SELECT jsonb_agg(e)
          FROM jsonb_array_elements(s.allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' NOT IN ('compute.sandbox', 'code.agent', 'code.repo')
        ), '[]'::jsonb),
        s.denied_capabilities,
        '["external_side_effect"]'::jsonb,
        '[]'::jsonb,
        false, false, true, NULL
      FROM "${schemaName}".capability_profiles s
      WHERE s.name = 'Standard' AND s.is_system_profile = true
        AND NOT EXISTS (
          SELECT 1 FROM "${schemaName}".capability_profiles
          WHERE name = 'Personal Safe' AND is_system_profile = true
        );

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (138, 'Plan 247 P0 — Personal Safe system profile (Standard minus compute/coding lanes)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
