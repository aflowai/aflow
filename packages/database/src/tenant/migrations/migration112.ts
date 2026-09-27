import type postgres from 'postgres';

export async function applyMigration112(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_run_tasks
        ADD COLUMN IF NOT EXISTS poll_cycle INTEGER NOT NULL DEFAULT 1;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (112, 'Op-task poll policy — workflow_run_tasks.poll_cycle (Plan 194)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
