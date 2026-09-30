import type postgres from 'postgres';

/**
 * A session waiter stays pending across a run's pauses, so which outcome it
 * last heard is recorded on the row: a second notification of the same pause
 * finds it already delivered.
 */
export async function applyMigration212(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_run_waiters
        ADD COLUMN IF NOT EXISTS last_delivered_key TEXT;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (212, 'A session waiter records the last outcome delivered to it')
      ON CONFLICT (version) DO NOTHING;
  `);
}
