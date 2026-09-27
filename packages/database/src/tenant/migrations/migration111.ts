import type postgres from 'postgres';

export async function applyMigration111(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS cancelled_by TEXT,
        ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (111, 'Operator-cancel legibility — workflow_runs.cancelled_by + cancel_reason')
      ON CONFLICT (version) DO NOTHING;
    `);
}
