/**
 * Tenant migration 12 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration012(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  // Migration 12: Space-scope all major entities + space type
  await sqlClient.unsafe(`
      -- Add space_id to agent_definitions (NULL = tenant-wide)
      ALTER TABLE "${schemaName}".agent_definitions
        ADD COLUMN IF NOT EXISTS space_id UUID;
  
      CREATE INDEX IF NOT EXISTS idx_agent_definitions_space
        ON "${schemaName}".agent_definitions (space_id)
        WHERE space_id IS NOT NULL;
  
      -- Add space_id to sessions (denormalized from agent for fast queries)
      ALTER TABLE "${schemaName}".sessions
        ADD COLUMN IF NOT EXISTS space_id UUID;
  
      CREATE INDEX IF NOT EXISTS idx_sessions_space
        ON "${schemaName}".sessions (space_id, started_at DESC)
        WHERE space_id IS NOT NULL;
  
      -- Add space_id to api_definitions (NULL = tenant-wide)
      ALTER TABLE "${schemaName}".api_definitions
        ADD COLUMN IF NOT EXISTS space_id UUID;
  
      CREATE INDEX IF NOT EXISTS idx_api_definitions_space
        ON "${schemaName}".api_definitions (space_id)
        WHERE space_id IS NOT NULL;
  
      -- Add type to spaces for distinguishing personal vs shared
      ALTER TABLE "${schemaName}".spaces
        ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'shared';
  
      -- Add owner_id to spaces (user who owns a personal space)
      ALTER TABLE "${schemaName}".spaces
        ADD COLUMN IF NOT EXISTS owner_id UUID;
  
      CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_personal_owner
        ON "${schemaName}".spaces (owner_id)
        WHERE type = 'personal' AND archived_at IS NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (12, 'Space-scope flow_definitions, flow_runs, api_definitions + space type/owner')
      ON CONFLICT (version) DO NOTHING;
    `);
}
