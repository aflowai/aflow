/**
 * Tenant migration 71 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration071(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- workflow_runs additive
      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS scheduler_cursor_version INTEGER NOT NULL DEFAULT 0;
  
      -- workflow_run_tasks additive
      ALTER TABLE "${schemaName}".workflow_run_tasks
        ADD COLUMN IF NOT EXISTS input_ref TEXT,
        ADD COLUMN IF NOT EXISTS pending_completion_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS dispatch_attempt_token TEXT;
  
      -- workflow_run_waiters: durable observers list. Helmsman sessions parked
      -- on a workflow run register here so the harness can wake them on
      -- terminal/pause/cancel via notifyWaiters. Multiple historical waiter
      -- rows allowed per (run, session) — partial unique index permits only one
      -- ACTIVE per (run, session) at a time. Repeated pause cycles in the same
      -- session create new waiter rows after the previous is notified.
      CREATE TABLE IF NOT EXISTS "${schemaName}".workflow_run_waiters (
        id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id                   TEXT NOT NULL REFERENCES "${schemaName}".workflow_runs(run_id) ON DELETE CASCADE,
        waiter_session_id        UUID NOT NULL,
        waiter_step_execution_id UUID NOT NULL,
        registered_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        notified_at              TIMESTAMPTZ,
        notified_outcome         TEXT
      );
  
      CREATE UNIQUE INDEX IF NOT EXISTS waiters_one_active_per_session
        ON "${schemaName}".workflow_run_waiters (run_id, waiter_session_id)
        WHERE notified_at IS NULL;
  
      CREATE INDEX IF NOT EXISTS waiters_run_id_pending
        ON "${schemaName}".workflow_run_waiters (run_id)
        WHERE notified_at IS NULL;
  
      -- workflow_run_completion_pending: durable record-pending entries. Inserted
      -- at task claim time AND at Runner-terminal detection. Cleared on durable
      -- record. Sweeper picks up rows past due_at and reconciles by inspecting
      -- the worker session's actual state (live → bump due_at; orphan →
      -- re-dispatch; terminal → re-run intercept).
      CREATE TABLE IF NOT EXISTS "${schemaName}".workflow_run_completion_pending (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id              TEXT NOT NULL REFERENCES "${schemaName}".workflow_runs(run_id) ON DELETE CASCADE,
        task_id             TEXT NOT NULL,
        attempt             INTEGER NOT NULL,
        worker_session_id   UUID NOT NULL,
        detected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        due_at              TIMESTAMPTZ NOT NULL,
        attempt_count       INTEGER NOT NULL DEFAULT 0,
        last_error          TEXT,
        CONSTRAINT pending_one_per_attempt UNIQUE (run_id, task_id, attempt)
      );
  
      CREATE INDEX IF NOT EXISTS pending_due
        ON "${schemaName}".workflow_run_completion_pending (due_at);
  
      -- attention_items: durable async surface. Workflow run state changes
      -- (terminal/pause/cancel) write rows here so any future Helmsman session
      -- can pick them up. Designed for v2 generic kinds; future plans add
      -- 'coach_proposal', 'user_notification', etc.
      CREATE TABLE IF NOT EXISTS "${schemaName}".attention_items (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           UUID NOT NULL,
        user_id             UUID,
        space_id            UUID,
        kind                TEXT NOT NULL,
        related_run_id      TEXT,
        related_resource    TEXT,
        payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
        priority            INTEGER NOT NULL DEFAULT 0,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        consumed_at         TIMESTAMPTZ,
        consumed_by_session UUID
      );
  
      CREATE INDEX IF NOT EXISTS attention_pending
        ON "${schemaName}".attention_items (tenant_id, user_id, created_at)
        WHERE consumed_at IS NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (71, 'Plan 132v2 Phase 1 — WorkflowRunHarness substrate (waiters, completion_pending, attention_items, scheduler_cursor_version, dispatch_attempt_token, input_ref)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
