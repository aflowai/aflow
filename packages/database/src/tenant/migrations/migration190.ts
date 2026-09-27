import type postgres from 'postgres';

/**
 * Drop the state-snapshot table nothing ever read or wrote.
 *
 * It was provisioned as a checkpoint for restoring session state cheaply, and
 * no code path was ever built on either side of it. The mount that would have
 * used it now folds one bounded page of the newest events instead, so the
 * checkpoint has nothing left to serve: it would be a derived copy of the event
 * log to keep coherent in exchange for work the reader no longer does.
 *
 * Its `state_ref` column was declared payload-collecting, so a purge walked it
 * for refs to release. Dropping it removes that walk along with the table.
 */
export async function applyMigration190(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      DROP TABLE IF EXISTS "${schemaName}".session_state_snapshots;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (190, 'Drop session_state_snapshots — provisioned as a checkpoint, never read or written')
      ON CONFLICT (version) DO NOTHING;
    `);
}
