import type postgres from 'postgres';

/**
 * One allocator for a simulation's world versions, and a unique index that
 * proves it.
 *
 * The version a call commits at is minted into entity ids before the call runs,
 * so it has to be handed out before any record exists — which the journal
 * cannot do. The two high-waters live on the run's pin row and are raised
 * inside the same locked transaction that reads the journal, so a call
 * carrying a dispatch identity and one carrying none can never name the same
 * number.
 *
 * The unique index is the standing guarantee rather than the mechanism: the
 * fold orders on `world_version_after`, so two records sharing a value order
 * arbitrarily and a run replays a world it never lived. A duplicate has to
 * fail at the write, where it is one refused call, instead of at the read,
 * where it is silent.
 */
export async function applyMigration188(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".simulation_run_contexts
        ADD COLUMN IF NOT EXISTS reserved_world_version integer NOT NULL DEFAULT 0;
      ALTER TABLE "${schemaName}".simulation_run_contexts
        ADD COLUMN IF NOT EXISTS unidentified_world_version integer NOT NULL DEFAULT 0;

      CREATE UNIQUE INDEX IF NOT EXISTS uniq_simulation_call_records_world_version
        ON "${schemaName}".simulation_call_records (space_id, run_id, simulation_id, world_version_after);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (188, 'Simulation world-version allocator high-waters and a unique version per (run, simulation)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
