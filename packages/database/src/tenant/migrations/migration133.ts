import type postgres from 'postgres';

export async function applyMigration133(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      TRUNCATE TABLE "${schemaName}".coach_candidate_learnings;

      ALTER TABLE "${schemaName}".coach_candidate_learnings
        ALTER COLUMN campaign_id DROP NOT NULL;

      ALTER TABLE "${schemaName}".coach_candidate_learnings
        ADD COLUMN IF NOT EXISTS space_id UUID NOT NULL,
        ADD COLUMN IF NOT EXISTS skill_slug TEXT NOT NULL;

      DROP INDEX IF EXISTS "${schemaName}".coach_candidate_identity_idx;
      DROP INDEX IF EXISTS "${schemaName}".coach_candidate_run_idx;

      -- Run ids are globally unique, so (run, learning) is the exact candidate
      -- identity; campaign membership becomes an attribute.
      CREATE UNIQUE INDEX IF NOT EXISTS coach_candidate_identity_idx
        ON "${schemaName}".coach_candidate_learnings (run_id, learning_id);

      CREATE INDEX IF NOT EXISTS coach_candidate_space_skill_status_idx
        ON "${schemaName}".coach_candidate_learnings (space_id, skill_slug, status);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (133, 'Plan 234 B2 — candidate ledger beyond campaigns: nullable campaign_id, space_id + skill_slug, (run_id, learning_id) identity')
      ON CONFLICT (version) DO NOTHING;
    `);
}
