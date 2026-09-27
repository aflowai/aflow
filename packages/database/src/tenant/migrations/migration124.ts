import type postgres from 'postgres';

export async function applyMigration124(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".campaigns
        ALTER COLUMN score_metric_key DROP NOT NULL;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (124, 'Plan 219 — score-optional campaigns: campaigns.score_metric_key nullable (process-mode skills campaign without a numeric metric)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
