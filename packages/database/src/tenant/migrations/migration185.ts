import type postgres from 'postgres';

/**
 * `integration.simulation` authorizes the operations that author and inspect a
 * simulation. Authoring one contacts no host, stores no credential and makes no
 * external call, so the write mode carries the same weight as the other
 * integration management groups the same profiles already hold.
 */
export async function applyMigration185(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"integration.simulation","accessMode":"read"},
          {"capabilityGroupId":"integration.simulation","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"integration.simulation","accessMode":"write"}]'::jsonb);

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"integration.simulation","accessMode":"read"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Read Only'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"integration.simulation","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (185, 'integration.simulation capability group in system profiles')
      ON CONFLICT (version) DO NOTHING;
    `);
}
