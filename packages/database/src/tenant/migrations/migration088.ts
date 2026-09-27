/**
 * Tenant migration 88 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration088(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      UPDATE "${schemaName}".capability_profiles
      SET allowed_capabilities = allowed_capabilities
        || '[{"capabilityGroupId":"catalog.tool","accessMode":"write"}]'::jsonb
      WHERE is_system_profile = true
        AND default_for_role IN ('admin', 'editor')
        AND NOT (allowed_capabilities @> '[{"capabilityGroupId":"catalog.tool","accessMode":"write"}]'::jsonb);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (88, 'Plan 155 — catalog.tool:write capability in Full Access + Standard profiles (catalog.tool.promote)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
