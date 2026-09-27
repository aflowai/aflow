import type postgres from 'postgres';

export async function applyMigration108(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".coach_candidate_learnings
        ADD COLUMN IF NOT EXISTS learning_id TEXT;

      UPDATE "${schemaName}".coach_candidate_learnings
        SET learning_id = COALESCE(learning_json->>'id', id::text)
        WHERE learning_id IS NULL;

      ALTER TABLE "${schemaName}".coach_candidate_learnings
        ALTER COLUMN learning_id SET NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS coach_candidate_identity_idx
        ON "${schemaName}".coach_candidate_learnings (campaign_id, run_id, learning_id);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (108, 'Plan 183e (PR #409) — coach_candidate_learnings.learning_id + identity unique index')
      ON CONFLICT (version) DO NOTHING;
    `);
}
