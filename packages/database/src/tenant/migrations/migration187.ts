import type postgres from 'postgres';

/**
 * The durable home for a run's pinned simulation context.
 *
 * The pin lived only in the session hot-state hash, which expires: a run
 * resuming past that point re-pinned to whatever the artifact and the latest
 * baseline held by then, and its journal — which outlives the hash — was then
 * folded onto a baseline the run never read. A row per `(run, simulation)`
 * rather than a map on the session row, because two simulations answering one
 * run pin separate worlds and pin them independently.
 *
 * `snapshot_ref` is a column of its own and not only a field inside
 * `context_json`: the session purge collects payload refs by selecting the
 * `*_ref` columns of the rows it deletes, so a ref reachable only from inside a
 * JSON body would leak its object forever.
 */
export async function applyMigration187(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".simulation_run_contexts (
        space_id       uuid NOT NULL,
        run_id         text NOT NULL,
        simulation_id  text NOT NULL,
        context_json   jsonb NOT NULL,
        snapshot_ref   text NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (space_id, run_id, simulation_id)
      );

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (187, 'Durable per-(run, simulation) pinned world context')
      ON CONFLICT (version) DO NOTHING;
    `);
}
