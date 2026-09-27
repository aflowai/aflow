import type postgres from 'postgres';

export async function applyMigration131(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".coach_learnings
        ADD COLUMN IF NOT EXISTS detail_ref TEXT;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (131, 'Plan 234 A3 — coach_learnings.detail_ref (memory doc path behind a learning)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
