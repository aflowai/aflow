import type postgres from 'postgres';

/**
 * Scheduled-call identity on the simulation journal.
 *
 * A per-endpoint ordinal and a world version counted on arrival depend on how
 * the executors happened to be scheduled, so two runs making the identical
 * calls disagree. The turn and the call's position within it are fixed before
 * any of the turn's steps is enqueued, which is what makes the recorded world
 * trace reproducible. Nullable: a workflow operation task belongs to no turn.
 */
export async function applyMigration186(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".simulation_call_records
        ADD COLUMN IF NOT EXISTS dispatch_turn            integer,
        ADD COLUMN IF NOT EXISTS dispatch_index           integer,
        ADD COLUMN IF NOT EXISTS dispatch_target_ordinal  integer;

      CREATE INDEX IF NOT EXISTS idx_simulation_call_records_dispatch
        ON "${schemaName}".simulation_call_records
        (space_id, run_id, simulation_id, dispatch_turn);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (186, 'Scheduled-call identity on the simulation call journal')
      ON CONFLICT (version) DO NOTHING;
    `);
}
