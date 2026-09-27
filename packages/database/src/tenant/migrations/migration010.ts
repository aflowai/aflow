/**
 * Tenant migration 10 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration010(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".spaces (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE,
        description TEXT,
        created_by  UUID,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        archived_at TIMESTAMPTZ,
        metadata    JSONB DEFAULT '{}'::jsonb
      );
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (10, 'Plan 27 — spaces table')
      ON CONFLICT (version) DO NOTHING;
    `);
}
