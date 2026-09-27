/**
 * Tenant migration 43 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration043(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".agent_definitions
        ADD COLUMN IF NOT EXISTS system_role TEXT
        GENERATED ALWAYS AS (definition_json->>'systemRole') STORED;
  
      -- One agent_id per system_role within a tenant. Seed path upserts by
      -- (agent_id, version); multiple agent_ids cannot claim the same role.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_definitions_system_role
        ON "${schemaName}".agent_definitions (system_role)
        WHERE system_role IS NOT NULL;
  
      -- Backfill the five capability flows that the platform has always shipped.
      -- Slug-match is safe because these IDs are reserved/immutable.
      -- Only rows seeded by the platform (created_by = 'system') get tagged.
      UPDATE "${schemaName}".agent_definitions
        SET definition_json = definition_json || jsonb_build_object('systemRole', agent_id)
        WHERE created_by = 'system'
          AND agent_id IN ('orchestrator', 'agent-builder', 'api-configurator', 'media-creator', 'mcp-runner')
          AND (definition_json ? 'systemRole') = false;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (43, 'Plan 102h Phase 0 — systemRole column + partial unique index + capability-flow backfill')
      ON CONFLICT (version) DO NOTHING;
    `);
}
