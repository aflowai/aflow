/**
 * Tenant migration 69 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration069(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".webhook_endpoints
        ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (69, 'Plan 121 — webhook_endpoints.metadata column for archive provenance')
      ON CONFLICT (version) DO NOTHING;
    `);
}
