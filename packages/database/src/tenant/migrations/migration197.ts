import type postgres from 'postgres';

/**
 * Give `Full Access` the local-MCP capability.
 *
 * Migration 195 drew the line between a capability that reaches only what an
 * operator named twice and one that is general execution: `host.file` was
 * granted, `host.process` withheld. A local MCP server sits on the near side of
 * that line, and it takes a moment to see why.
 *
 * `host.process` runs the argv it is handed — the request chooses the program.
 * `host.mcp` can only run a server the machine's own policy declares, in the
 * binding that policy names, and only where the operator granted execution.
 * The request picks from a list it cannot add to. What it reaches is the same
 * folder `host.file` reaches, through a program the operator installed and
 * approved.
 *
 * Withheld from the narrower profiles, and from `Personal Safe`: this is still
 * a program running on the operator's machine, and the most permissive profile
 * is the right place for it.
 */
export async function applyMigration197(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"host.mcp","accessMode":"read"},
          {"capabilityGroupId":"host.mcp","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Full Access'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"host.mcp","accessMode":"write"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (197, 'Full Access may use local MCP servers')
      ON CONFLICT (version) DO NOTHING;
  `);
}
