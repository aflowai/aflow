/**
 * Tenant migration 19 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration019(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".agent_schedules
        ADD COLUMN IF NOT EXISTS creator_user_id UUID,
        ADD COLUMN IF NOT EXISTS creator_tenant_role TEXT,
        ADD COLUMN IF NOT EXISTS creator_space_role TEXT;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (19, 'Plan 28 — Schedule creator context for grant stamping')
      ON CONFLICT (version) DO NOTHING;
    `);
}
