/**
 * Tenant migration 32 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration032(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 32: Composite PK on api_definitions (api_id, space_id).
  // Previously api_id was the sole PK, meaning one definition per tenant regardless
  // of space. This caused cross-space overwrites and invisible definitions.
  await sqlClient.unsafe(`
      -- Backfill any remaining NULL space_ids (migration 13 should have caught these)
      UPDATE "${schemaName}".api_definitions
        SET space_id = (SELECT id FROM "${schemaName}".spaces WHERE slug = 'general')
        WHERE space_id IS NULL;
  
      -- Make space_id NOT NULL
      ALTER TABLE "${schemaName}".api_definitions
        ALTER COLUMN space_id SET NOT NULL;
  
      -- Drop old single-column PK and add composite PK
      ALTER TABLE "${schemaName}".api_definitions
        DROP CONSTRAINT IF EXISTS api_definitions_pkey;
      ALTER TABLE "${schemaName}".api_definitions
        ADD PRIMARY KEY (api_id, space_id);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (32, 'Composite PK on api_definitions (api_id, space_id) — space-scoped definitions')
      ON CONFLICT (version) DO NOTHING;
    `);
}
