import type postgres from 'postgres';

/**
 * Let `Personal Safe` run compute-sandbox operations.
 *
 * Plan 247 D2 excluded `compute.sandbox` from the member default alongside
 * the coding lane, on the reasoning that both execute on shared platform
 * infrastructure. The two are not the same shape of risk. The coding lane
 * needs a git credential and open egress against a real repository; the
 * compute sandbox is an ephemeral, network-isolated container with no host
 * mounts and no credentials (Plan 188 §4.K) — ordinary authoring capability,
 * not shared-infrastructure exposure. Withholding it made every member space
 * unable to run a Store skill that trains a model or transforms a dataset —
 * the ordinary case, not an edge one — without a tenant admin's per-user
 * grant or profile reassignment first.
 *
 * `code.agent` / `code.repo` stay excluded; that risk shape is unchanged.
 */
export async function applyMigration204(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET
        allowed_capabilities = allowed_capabilities
          || '[
            {"capabilityGroupId":"compute.sandbox","accessMode":"read"},
            {"capabilityGroupId":"compute.sandbox","accessMode":"write"}
          ]'::jsonb,
        description = 'Standard authoring without the coding lane. Default for member-created spaces.'
      WHERE is_system_profile = true
        AND name = 'Personal Safe'
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"compute.sandbox","accessMode":"write"}]'::jsonb);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (204, 'Personal Safe may run compute-sandbox operations (Plan 247 D2 narrowed)')
      ON CONFLICT (version) DO NOTHING;
  `);
}
