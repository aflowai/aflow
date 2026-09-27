/**
 * Tenant migration 46 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration046(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".entity_event_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id UUID NOT NULL,
        event_type TEXT NOT NULL,
        space_id UUID NOT NULL,
        timestamp BIGINT NOT NULL,
        trace_id TEXT,
        caused_by_session_id UUID,
        caused_by_step_execution_id UUID,
        caused_by_entity_event_id UUID,
        workflow_slug TEXT,
        workflow_run_id UUID,
        operating_mode TEXT,
        payload JSONB NOT NULL DEFAULT '{}',
        summary TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE INDEX IF NOT EXISTS idx_entity_event_log_space_ts
        ON "${schemaName}".entity_event_log (space_id, timestamp DESC);
  
      CREATE INDEX IF NOT EXISTS idx_entity_event_log_type
        ON "${schemaName}".entity_event_log (event_type, space_id);
  
      CREATE INDEX IF NOT EXISTS idx_entity_event_log_causal
        ON "${schemaName}".entity_event_log (caused_by_entity_event_id)
        WHERE caused_by_entity_event_id IS NOT NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (46, 'Plan 102e — entity_event_log table for durable entity event storage')
      ON CONFLICT (version) DO NOTHING;
    `);
}
