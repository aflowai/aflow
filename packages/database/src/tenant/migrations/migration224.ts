import type postgres from 'postgres';

/**
 * Plan 325 — every system capability profile may read the help catalog. Help
 * is platform-owned and read-only, so Full Access, Standard and Read Only all
 * take the same grant.
 */
export async function applyMigration224(client: postgres.Sql, schema: string): Promise<void> {
  await client.unsafe(`
    UPDATE "${schema}".capability_profiles SET allowed_capabilities = allowed_capabilities ||
      '[{"capabilityGroupId":"catalog.help","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"catalog.help","accessMode":"read"}]'::jsonb);
    INSERT INTO "${schema}".schema_migrations (version, description)
      VALUES (224, 'Plan 325 — system capability profiles read the help catalog') ON CONFLICT (version) DO NOTHING;
  `);
}
