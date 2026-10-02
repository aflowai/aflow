import type postgres from 'postgres';

/**
 * `Full Access`, `Standard` and `Personal Safe` carry `host.commit:write`.
 *
 * `host.commit.check` runs the checks a connected folder declares in a
 * checkout of a commit: the repository's own code, which is execution whatever
 * the command is. Local Publish runs it on its commit before every push, so a
 * profile without the grant refuses the publication before anything leaves the
 * machine. The three profiles here are the ones that already run commands on
 * a connected machine (migrations 199 and 208); a publication needs that too,
 * for its push.
 *
 * `Read Only` takes nothing: it runs nothing. It keeps `host.commit:read`, the
 * scan, from migration 214.
 */
export async function applyMigration216(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"host.commit","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard', 'Personal Safe')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"host.commit","accessMode":"write"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (216, 'Full Access, Standard and Personal Safe may run a folder''s checks on a commit')
      ON CONFLICT (version) DO NOTHING;
  `);
}
