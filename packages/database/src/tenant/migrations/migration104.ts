import type postgres from 'postgres';

export async function applyMigration104(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (104, 'Plan 184 — workflow_runs.score (nullable; populated by Plan 183c)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
