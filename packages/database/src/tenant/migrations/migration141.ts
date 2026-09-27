import type postgres from 'postgres';

export async function applyMigration141(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".spaces
        ADD COLUMN IF NOT EXISTS active_memory jsonb;

      -- admin + editor system profiles: memory.context read+write
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities ||
        '[{"capabilityGroupId":"memory.context","accessMode":"read"},{"capabilityGroupId":"memory.context","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role IN ('admin', 'editor')
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'memory.context'
        );

      -- viewer: read only
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities ||
        '[{"capabilityGroupId":"memory.context","accessMode":"read"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role = 'viewer'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'memory.context'
        );

      -- Personal Safe (member personal spaces — the Phase 1 target): read+write
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities ||
        '[{"capabilityGroupId":"memory.context","accessMode":"read"},{"capabilityGroupId":"memory.context","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND name = 'Personal Safe'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(allowed_capabilities) AS e
          WHERE e->>'capabilityGroupId' = 'memory.context'
        );

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (141, 'Plan 251 P1 — spaces.active_memory register column + memory.context capability group')
      ON CONFLICT (version) DO NOTHING;
    `);
}
