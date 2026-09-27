import type postgres from 'postgres';

/**
 * `Full Access` and `Standard` carry the host capability groups; `Read Only`
 * carries their read modes.
 *
 * Migrations 195 and 199 added `host.file`, `host.process`, `host.harness` and
 * `host.mcp` to `Personal Safe` alone, so a space created through the ordinary
 * route — which assigns `Full Access` — refused every host operation after the
 * operator had paired a machine and connected a folder with commands allowed.
 * The profile named for granting everything granted less than the one named
 * for restraint.
 *
 * What bounds a host operation is the binding: `allowsExecution` is set by the
 * operator per folder on their own machine, connecting a folder refuses MCP
 * servers unless execution is allowed, and a deployment with no host lane
 * refuses to connect a folder at all. The profile adding a second opinion on
 * top of those only made the operator's own choice unusable.
 */
export async function applyMigration208(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"host.file","accessMode":"read"},
          {"capabilityGroupId":"host.file","accessMode":"write"},
          {"capabilityGroupId":"host.process","accessMode":"read"},
          {"capabilityGroupId":"host.process","accessMode":"write"},
          {"capabilityGroupId":"host.harness","accessMode":"read"},
          {"capabilityGroupId":"host.harness","accessMode":"write"},
          {"capabilityGroupId":"host.mcp","accessMode":"read"},
          {"capabilityGroupId":"host.mcp","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name IN ('Full Access', 'Standard')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"host.harness","accessMode":"write"}]'::jsonb);

      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"host.file","accessMode":"read"},
          {"capabilityGroupId":"host.process","accessMode":"read"},
          {"capabilityGroupId":"host.harness","accessMode":"read"},
          {"capabilityGroupId":"host.mcp","accessMode":"read"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Read Only'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"host.harness","accessMode":"read"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (208, 'Full Access and Standard carry the host capability groups; Read Only carries their read modes')
      ON CONFLICT (version) DO NOTHING;
  `);
}
