import type postgres from 'postgres';

export async function applyMigration115(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".campaigns
        ADD COLUMN IF NOT EXISTS config JSONB,
        ADD COLUMN IF NOT EXISTS contract_hash TEXT;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (115, 'Plan 195 — campaigns.config + contract_hash (skill-instance config)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
