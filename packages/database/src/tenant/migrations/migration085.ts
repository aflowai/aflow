/**
 * Tenant migration 85 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration085(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- Step 1: add space_id (nullable for backfill).
      ALTER TABLE "${schemaName}".mcp_oauth_tokens
        ADD COLUMN IF NOT EXISTS space_id UUID;
  
      -- Step 2: backfill from the binding row (every token row references exactly
      -- one binding_id; post-migration 84 there can be multiple binding rows with
      -- that id across spaces, so pick the lexicographically-smallest space_id as
      -- a deterministic but arbitrary choice — defensible because the table is
      -- empty pre-Phase-5).
      UPDATE "${schemaName}".mcp_oauth_tokens t
        SET space_id = (
          SELECT MIN(b.space_id::text)::uuid
          FROM "${schemaName}".mcp_server_bindings b
          WHERE b.binding_id = t.binding_id
        )
        WHERE t.space_id IS NULL;
  
      -- Step 3: drop any orphan token rows whose binding no longer exists.
      DELETE FROM "${schemaName}".mcp_oauth_tokens WHERE space_id IS NULL;
  
      -- Step 4: lock space_id down as NOT NULL.
      ALTER TABLE "${schemaName}".mcp_oauth_tokens
        ALTER COLUMN space_id SET NOT NULL;
  
      -- Step 5: drop the old composite PK (binding_id, credential_owner) and add
      -- the new triplet (binding_id, space_id, credential_owner).
      ALTER TABLE "${schemaName}".mcp_oauth_tokens
        DROP CONSTRAINT IF EXISTS mcp_oauth_tokens_pkey;
      ALTER TABLE "${schemaName}".mcp_oauth_tokens
        ADD PRIMARY KEY (binding_id, space_id, credential_owner);
  
      -- Lookup index: executor resolves "tokens for this (binding, space)" before
      -- choosing a credential_owner row by current user/tenant.
      DROP INDEX IF EXISTS "${schemaName}".idx_mcp_oauth_tokens_binding;
      CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_binding_space
        ON "${schemaName}".mcp_oauth_tokens (binding_id, space_id);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (85, 'Plan 103 Phase 1 — mcp_oauth_tokens PK extended with space_id for cross-space binding isolation')
      ON CONFLICT (version) DO NOTHING;
    `);
}
