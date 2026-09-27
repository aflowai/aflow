import type postgres from 'postgres';

/**
 * Let `Personal Safe` run commands in a folder the operator said may run them.
 *
 * Migration 195 withheld `host.process` from every profile, and its reasoning
 * was sound as far as it went: "Running commands is general execution wherever
 * it happens, and it is the grant that should be chosen rather than defaulted."
 * The choosing already happens, one level down and at a finer grain. A binding
 * carries `allowsExecution`, set by the operator on their own machine, per
 * folder, while connecting it — which is the deliberate act 195 asks for. A
 * folder connected without it runs nothing whatever this profile says.
 *
 * So the profile was a second, coarser opinion about a decision already made
 * explicitly, and its only effect was to make the operator's own choice
 * unusable — the same fault 195 identified for `host.file` and fixed there. Two
 * dogfood runs died on it after the operator had connected a folder with
 * commands allowed and watched every command refused.
 *
 * `host.harness` and `host.mcp` follow for the same reason and are already
 * narrower: connecting a folder refuses MCP servers outright unless execution
 * is allowed, so the binding gates them before this profile is consulted.
 *
 * What is unchanged: the sandbox, which is what actually bounds a command.
 * Home is denied as a region, egress is closed until a profile names a host,
 * and a path outside the binding is refused rather than resolved.
 */
export async function applyMigration199(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[
          {"capabilityGroupId":"host.process","accessMode":"read"},
          {"capabilityGroupId":"host.process","accessMode":"write"},
          {"capabilityGroupId":"host.harness","accessMode":"read"},
          {"capabilityGroupId":"host.harness","accessMode":"write"},
          {"capabilityGroupId":"host.mcp","accessMode":"read"},
          {"capabilityGroupId":"host.mcp","accessMode":"write"}
        ]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Personal Safe'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"host.process","accessMode":"write"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (199, 'Personal Safe runs commands where the binding allows them')
      ON CONFLICT (version) DO NOTHING;
  `);
}
