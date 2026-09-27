import type postgres from 'postgres';

/**
 * Give a task re-armed for retry a deadline by which it must have been claimed.
 *
 * A retry commit flips the task row back to `running` and clears its worker
 * session, then a separate call in a separate step claims it. Between the two
 * the row is durably `running` with no worker and no completion-pending row —
 * and every reader treats `running` as live, so the state is not merely
 * unmarked but actively invisible. A deadline written by the commit itself is
 * what lets a reader tell "committed a moment ago" from "wedged since the
 * process died".
 */
export async function applyMigration169(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_run_tasks
        ADD COLUMN IF NOT EXISTS dispatch_deadline_at TIMESTAMPTZ;

      -- Partial, so the anomaly lookup costs nothing while no retry is in
      -- flight: the claim clears the column, so a healthy row leaves the index.
      CREATE INDEX IF NOT EXISTS workflow_run_tasks_dispatch_deadline_idx
        ON "${schemaName}".workflow_run_tasks (dispatch_deadline_at)
        WHERE status = 'running' AND worker_session_id IS NULL
          AND dispatch_deadline_at IS NOT NULL;

      -- Rows already wedged in that state get a deadline of now, so they become
      -- overdue on the next pass. Without this the population the column exists
      -- for is the one population it cannot see: their deadline is NULL, the
      -- overdue check reads NULL as "not overdue", and nothing will ever write
      -- them again to fill it in.
      UPDATE "${schemaName}".workflow_run_tasks
         SET dispatch_deadline_at = now()
       WHERE status = 'running'
         AND worker_session_id IS NULL
         AND dispatch_deadline_at IS NULL;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (169, 'Dispatch deadline for a task re-armed by retry or re-execute')
      ON CONFLICT (version) DO NOTHING;
    `);
}
