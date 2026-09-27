/**
 * Tenant migration 18 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration018(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".agent_schedules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
  
        -- Identity
        name TEXT NOT NULL,
        description TEXT,
  
        -- Action
        action TEXT NOT NULL DEFAULT 'start_run',
        agent_id TEXT,
        agent_version TEXT,
        target_session_id UUID,
        target_step_execution_id UUID,
  
        -- When
        kind TEXT NOT NULL,
        cron_expression TEXT,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        scheduled_at TIMESTAMPTZ,
        source_agent_id TEXT,
        source_status TEXT,
  
        -- Input
        input_template JSONB NOT NULL DEFAULT '{}',
  
        -- Lifecycle
        status TEXT NOT NULL DEFAULT 'active',
        max_firings INT,
        firing_count INT NOT NULL DEFAULT 0,
        last_fired_at TIMESTAMPTZ,
        last_session_id UUID,
        next_fire_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        last_error TEXT,
  
        -- Provenance
        created_by TEXT,
        created_by_session_id UUID,
        metadata JSONB DEFAULT '{}',
  
        -- Timestamps
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      -- Scheduler polling: finds due cron/one_shot schedules efficiently
      CREATE INDEX IF NOT EXISTS idx_agent_schedules_next_fire
        ON "${schemaName}".agent_schedules (next_fire_at)
        WHERE status = 'active' AND kind IN ('cron', 'one_shot');
  
      -- Event matching: finds on_completion schedules for a given source agent
      CREATE INDEX IF NOT EXISTS idx_agent_schedules_on_completion
        ON "${schemaName}".agent_schedules (source_agent_id, source_status)
        WHERE status = 'active' AND kind = 'on_completion';
  
      -- Space listing: list schedules in a space
      CREATE INDEX IF NOT EXISTS idx_agent_schedules_space
        ON "${schemaName}".agent_schedules (space_id, status);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (18, 'Plan 58 — Flow schedules (cron, one-shot, on-completion)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
