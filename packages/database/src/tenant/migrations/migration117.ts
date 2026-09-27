import type postgres from 'postgres';

export async function applyMigration117(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".campaigns
        ADD COLUMN IF NOT EXISTS config_history JSONB NOT NULL DEFAULT '[]'::jsonb;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (117, 'Plan 195 §4.5 — campaigns.config_history (config-change ledger)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
