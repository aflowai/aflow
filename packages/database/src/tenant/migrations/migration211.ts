import type postgres from 'postgres';

/**
 * A session that starts a run without waiting on it is the run's waiter, and no
 * step of it is parked: its wakeup arrives as a session event.
 */
export async function applyMigration211(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_run_waiters
        ALTER COLUMN waiter_step_execution_id DROP NOT NULL;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (211, 'A run waiter may be a session with no parked step')
      ON CONFLICT (version) DO NOTHING;
  `);
}
