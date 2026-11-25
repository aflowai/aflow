import type postgres from 'postgres';

/**
 * The durable link from a session to the dry run it works for. A dry run's
 * session is linked here before its hot state exists, so the hold reads the
 * run's row through the link when the session hash is missing or corrupt.
 */
export async function applyMigration242(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".workflow_run_dry_run_sessions (
        session_id text PRIMARY KEY,
        run_id text NOT NULL REFERENCES "${schemaName}".workflow_runs(run_id) ON DELETE CASCADE,
        task_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS workflow_run_dry_run_sessions_run
        ON "${schemaName}".workflow_run_dry_run_sessions (run_id);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (242, 'workflow_run_dry_run_sessions — the durable session link of a dry run')
      ON CONFLICT (version) DO NOTHING;
    `);
}
