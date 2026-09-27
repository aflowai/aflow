/**
 * Tenant migration 90 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration090(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".capability_profiles
        ADD COLUMN IF NOT EXISTS gated_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (90, 'Plan 156 §5.5.1 — capability_profiles.gated_capabilities column')
      ON CONFLICT (version) DO NOTHING;
    `);
}
