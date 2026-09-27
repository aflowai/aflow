import type postgres from 'postgres';

export async function applyMigration107(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS score_provenance JSONB,
        ADD COLUMN IF NOT EXISTS campaign_id UUID;

      CREATE INDEX IF NOT EXISTS workflow_runs_campaign_idx
        ON "${schemaName}".workflow_runs (campaign_id);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (107, 'Plan 183c/183e — workflow_runs.score_provenance + campaign_id')
      ON CONFLICT (version) DO NOTHING;
    `);
}
