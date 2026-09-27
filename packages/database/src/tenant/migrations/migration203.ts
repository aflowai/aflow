import type postgres from 'postgres';

/**
 * The agent versions a run is pinned to, by agent id.
 *
 * An eval batch records what each agent task resolved to at launch, but
 * dispatch built its Runner session with `agentVersion: 'latest'`, so the
 * manifest described a subject the trial did not necessarily run. Checking the
 * version before dispatch narrowed the window without closing it: an edit
 * landing between the check and the spawn still ran unpinned.
 *
 * Carried on the run so the value reaches the dispatch that spawns the Runner,
 * which is the only place the choice is actually made.
 */
export async function applyMigration203(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS agent_version_pins JSONB;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (203, 'workflow_runs.agent_version_pins — the pin reaches the dispatch that chooses the version')
      ON CONFLICT (version) DO NOTHING;
    `);
}
