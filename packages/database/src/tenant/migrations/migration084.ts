/**
 * Tenant migration 84 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration084(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- Step 1: add space_id (nullable for the backfill window).
      ALTER TABLE "${schemaName}".mcp_server_bindings
        ADD COLUMN IF NOT EXISTS space_id UUID;
  
      -- Step 2: backfill from scope_json.spaceId; fall back to the General space when absent.
      UPDATE "${schemaName}".mcp_server_bindings
        SET space_id = COALESCE(
          (scope_json->>'spaceId')::uuid,
          (SELECT id FROM "${schemaName}".spaces WHERE slug = 'general')
        )
        WHERE space_id IS NULL;
  
      -- Step 3: ensure scope_json.spaceId reflects the column for legacy tenant-wide rows
      -- that got backfilled into the General space.
      UPDATE "${schemaName}".mcp_server_bindings
        SET scope_json = jsonb_set(scope_json, '{spaceId}', to_jsonb(space_id::text), true)
        WHERE scope_json->>'spaceId' IS DISTINCT FROM space_id::text;
  
      -- Step 4: lock space_id down as NOT NULL.
      ALTER TABLE "${schemaName}".mcp_server_bindings
        ALTER COLUMN space_id SET NOT NULL;
  
      -- Step 5: drop the single-column PK and add composite PK.
      ALTER TABLE "${schemaName}".mcp_server_bindings
        DROP CONSTRAINT IF EXISTS mcp_server_bindings_pkey;
      ALTER TABLE "${schemaName}".mcp_server_bindings
        ADD PRIMARY KEY (binding_id, space_id);
  
      -- Index reads that resolve a binding by space (the new hot path on CRUD routes).
      CREATE INDEX IF NOT EXISTS idx_mcp_server_bindings_space
        ON "${schemaName}".mcp_server_bindings (space_id) WHERE enabled = 1;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (84, 'Plan 103 Phase 1 — composite PK on mcp_server_bindings (binding_id, space_id) — space-scoped bindings')
      ON CONFLICT (version) DO NOTHING;
    `);
}
