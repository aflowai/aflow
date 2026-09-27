import type postgres from 'postgres';

export async function applyMigration102(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_run_tasks
        ADD COLUMN IF NOT EXISTS human_task_hydration_ref TEXT,
        ADD COLUMN IF NOT EXISTS human_task_hydration_pause_version INTEGER,
        ADD COLUMN IF NOT EXISTS human_task_hydration_attempt INTEGER;

      -- Plan 170 §7.1.1 — drift-diagnostic index. Cheap to keep because
      -- the partial WHERE keeps the index tiny (only paused rows with
      -- no hydration ref). Used by the missing-hydration alarm and the
      -- backfill script's "needs repair" query.
      CREATE INDEX IF NOT EXISTS workflow_run_tasks_missing_hydration_idx
        ON "${schemaName}".workflow_run_tasks (run_id, task_id)
        WHERE status = 'paused' AND human_task_hydration_ref IS NULL;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (102, 'Plan 170 §7.1.1 — durable human-task hydration columns on workflow_run_tasks')
      ON CONFLICT (version) DO NOTHING;
    `);
}
