import type postgres from 'postgres';

/**
 * Plan 345 D: `Full Access` and `Standard` carry `space.autonomy` write, the
 * group of `space.autonomy.update`. The group has no read operation, since
 * the space context carries the setting, so `Read Only` gains nothing. The
 * operation itself writes only for a session whose user is an admin of the
 * space, as the autonomy route requires.
 */
export async function applyMigration240(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"space.autonomy","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"space.autonomy","accessMode":"write"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (240, 'Full Access and Standard carry the space.autonomy capability group')
      ON CONFLICT (version) DO NOTHING;
  `);
}
