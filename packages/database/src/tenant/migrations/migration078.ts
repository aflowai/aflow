/**
 * Tenant migration 78 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration078(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- Step 1: add space_id (nullable for the backfill window).
      ALTER TABLE "${schemaName}".api_bindings
        ADD COLUMN IF NOT EXISTS space_id UUID;
  
      -- Step 2: backfill from scope_json.spaceId; fall back to the general space when absent
      -- (matches the migration 32 / 33 convention for legacy rows).
      UPDATE "${schemaName}".api_bindings
        SET space_id = COALESCE(
          (scope_json->>'spaceId')::uuid,
          (SELECT id FROM "${schemaName}".spaces WHERE slug = 'general')
        )
        WHERE space_id IS NULL;
  
      -- Step 3: lock space_id down as NOT NULL.
      ALTER TABLE "${schemaName}".api_bindings
        ALTER COLUMN space_id SET NOT NULL;
  
      -- Step 4: drop the old single-column PK and add composite PK.
      ALTER TABLE "${schemaName}".api_bindings
        DROP CONSTRAINT IF EXISTS api_bindings_pkey;
      ALTER TABLE "${schemaName}".api_bindings
        ADD PRIMARY KEY (binding_id, space_id);
  
      -- Index reads that resolve a binding by id+space (the new hot path).
      CREATE INDEX IF NOT EXISTS idx_api_bindings_space
        ON "${schemaName}".api_bindings (space_id) WHERE enabled = 1;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (78, 'Plan 150 Phase 0 — composite PK on api_bindings (binding_id, space_id) — space-scoped bindings')
      ON CONFLICT (version) DO NOTHING;
    `);
}
