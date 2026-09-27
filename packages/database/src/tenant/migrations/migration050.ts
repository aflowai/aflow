/**
 * Tenant migration 50 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration050(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".workflow_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        workflow_slug TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_id UUID,
        status TEXT NOT NULL,
        workflow_revision INT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        total_cost_cents INT,
        total_tokens INT,
        evaluation_json JSONB,
        failure_json JSONB,
        learnings_json JSONB,
        scheduler_cursor_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB
      );
  
      CREATE INDEX IF NOT EXISTS workflow_runs_space_status_idx
        ON "${schemaName}".workflow_runs (space_id, status);
      CREATE INDEX IF NOT EXISTS workflow_runs_space_slug_started_idx
        ON "${schemaName}".workflow_runs (space_id, workflow_slug, started_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_run_id_idx
        ON "${schemaName}".workflow_runs (run_id);
  
      CREATE TABLE IF NOT EXISTS "${schemaName}".workflow_run_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id TEXT NOT NULL REFERENCES "${schemaName}".workflow_runs (run_id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INT NOT NULL DEFAULT 1,
        session_id TEXT,
        worker_session_id UUID,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        duration_ms INT,
        cost_cents INT,
        metrics_json JSONB,
        summary TEXT,
        failure_reason TEXT,
        output_ref TEXT,
        UNIQUE (run_id, task_id)
      );
  
      CREATE INDEX IF NOT EXISTS workflow_run_tasks_run_status_idx
        ON "${schemaName}".workflow_run_tasks (run_id, status);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (50, 'Plan 104c Phase 2 — workflow_runs + workflow_run_tasks tables')
      ON CONFLICT (version) DO NOTHING;
    `);
}
