import type postgres from 'postgres';

/**
 * Carry a workflow run's simulation pins on the run row.
 *
 * A simulated world is pinned per `(run, simulation)`, and the run that makes
 * the API call is the Runner SESSION — which the harness starts later, one per
 * task. Holding the pins only on the workflow-run operation would leave every
 * session it spawns to resolve its own defaults, so a workflow told to act as
 * one persona would run its tasks as another.
 */
export async function applyMigration192(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS simulation_run_input_json jsonb;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (192, 'workflow_runs.simulation_run_input_json — pins the Runner sessions a run spawns')
      ON CONFLICT (version) DO NOTHING;
    `);
}
