import type postgres from 'postgres';

/**
 * Give `Personal Safe` the host file capability, and only that.
 *
 * Migration 193 withheld it on the same reasoning that keeps compute and the
 * coding lane out: a workspace should not acquire authority by being created.
 * That reasoning does not survive contact with what a host binding is. Compute
 * and the coding lane are general execution — grant them and a run may do
 * anything they can do. `host.file` reaches exactly the folders an operator
 * named twice, once on this instance and once on their own machine, and reaches
 * nothing at all until they have. The binding is the deliberate act; withholding
 * the capability as well left the operator's own choice unusable.
 *
 * `host.process` stays out, of Personal Safe and of every profile. Running
 * commands is general execution wherever it happens, and it is the grant that
 * should be chosen rather than defaulted.
 */
export async function applyMigration195(
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
        AND name = 'Personal Safe'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"host.file","accessMode":"write"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (195, 'Personal Safe reaches connected host folders')
      ON CONFLICT (version) DO NOTHING;
  `);
}
