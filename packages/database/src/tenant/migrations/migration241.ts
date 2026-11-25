import type postgres from 'postgres';

/**
 * Dry runs of a skill. `workflow_runs.dry_run` marks a run whose writes the
 * platform holds, and `workflow_run_held_writes` records each write it held,
 * keyed by the step attempt so a redelivered result records it once.
 */
export async function applyMigration241(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS dry_run boolean NOT NULL DEFAULT false;

      CREATE TABLE IF NOT EXISTS "${schemaName}".workflow_run_held_writes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id text NOT NULL REFERENCES "${schemaName}".workflow_runs(run_id) ON DELETE CASCADE,
        task_id text,
        session_id text,
        step_execution_id text NOT NULL,
        attempt integer NOT NULL,
        operation_id text NOT NULL,
        target text NOT NULL,
        preview text,
        held_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS workflow_run_held_writes_step_attempt
        ON "${schemaName}".workflow_run_held_writes (step_execution_id, attempt);

      CREATE INDEX IF NOT EXISTS workflow_run_held_writes_run
        ON "${schemaName}".workflow_run_held_writes (run_id, held_at);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (241, 'workflow_runs.dry_run and workflow_run_held_writes — dry runs hold every write')
      ON CONFLICT (version) DO NOTHING;
    `);
}
