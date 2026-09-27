import type postgres from 'postgres';

export async function applyMigration134(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".coach_learnings
        ADD COLUMN IF NOT EXISTS applies_to JSONB;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (134, 'Plan 234 B3 — coach_learnings.applies_to task targeting')
      ON CONFLICT (version) DO NOTHING;
    `);
}
