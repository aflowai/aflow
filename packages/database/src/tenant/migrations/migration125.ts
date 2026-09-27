import type postgres from 'postgres';

export async function applyMigration125(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".campaigns
        ALTER COLUMN score_metric_key SET NOT NULL;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (125, 'Plan 219 — every campaign declares a score metric: campaigns.score_metric_key NOT NULL (process campaigns get a default/completion score, never no score)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
