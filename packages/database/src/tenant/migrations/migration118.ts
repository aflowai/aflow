import type postgres from 'postgres';

export async function applyMigration118(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".coach_activity
        DROP COLUMN IF EXISTS evidence_tier,
        DROP COLUMN IF EXISTS intervention_level;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (118, 'Plan 201 — drop coach_activity.evidence_tier/intervention_level (intent matrix removed)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
