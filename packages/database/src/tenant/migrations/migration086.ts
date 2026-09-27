/**
 * Tenant migration 86 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration086(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".mcp_oauth_state
        ADD COLUMN IF NOT EXISTS space_id UUID;
  
      -- Backfill: pre-Phase-5 the table is empty, but if any orphaned rows
      -- exist, route them to the General space so the NOT NULL constraint can
      -- be applied without losing data.
      UPDATE "${schemaName}".mcp_oauth_state s
        SET space_id = COALESCE(
          (SELECT b.space_id FROM "${schemaName}".mcp_server_bindings b
            WHERE b.binding_id = s.binding_id LIMIT 1),
          (SELECT id FROM "${schemaName}".spaces WHERE slug = 'general')
        )
        WHERE space_id IS NULL;
  
      ALTER TABLE "${schemaName}".mcp_oauth_state
        ALTER COLUMN space_id SET NOT NULL;
  
      -- Composite lookup index for the callback path (state is still the PK).
      CREATE INDEX IF NOT EXISTS idx_mcp_oauth_state_binding_space
        ON "${schemaName}".mcp_oauth_state (binding_id, space_id);
  
      -- (b) credential_owner_mode on bindings + CHECK constraint matching
      -- the Zod enum so a future code change writing an unexpected value
      -- (e.g. 'org' / 'workspace') fails at the DB rather than silently
      -- diverging from the runtime enum.
      ALTER TABLE "${schemaName}".mcp_server_bindings
        ADD COLUMN IF NOT EXISTS credential_owner_mode TEXT NOT NULL DEFAULT 'tenant';
      ALTER TABLE "${schemaName}".mcp_server_bindings
        DROP CONSTRAINT IF EXISTS mcp_server_bindings_credential_owner_mode_check;
      ALTER TABLE "${schemaName}".mcp_server_bindings
        ADD CONSTRAINT mcp_server_bindings_credential_owner_mode_check
        CHECK (credential_owner_mode IN ('tenant', 'user'));
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (86, 'Plan 103 Phase 5 — mcp_oauth_state.space_id + mcp_server_bindings.credential_owner_mode (+CHECK)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
