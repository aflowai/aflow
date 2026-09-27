/**
 * Tenant migration 21 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration021(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".spaces ADD COLUMN IF NOT EXISTS default_agent_id TEXT;
  
      -- Backfill: set General space's default agent to 'orchestrator'
      UPDATE "${schemaName}".spaces
      SET default_agent_id = 'orchestrator'
      WHERE slug = 'general' AND default_agent_id IS NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (21, 'Plan 64 — default_flow_id on spaces')
      ON CONFLICT (version) DO NOTHING;
    `);
}
