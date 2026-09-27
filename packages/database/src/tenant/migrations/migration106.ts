import type postgres from 'postgres';

export async function applyMigration106(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".coach_candidate_learnings (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id           UUID NOT NULL,
        run_id                TEXT NOT NULL,
        learning_id           TEXT NOT NULL,
        learning_json         JSONB NOT NULL,
        status                TEXT NOT NULL DEFAULT 'pending',
        compact_eval_outcome  JSONB,
        refs                  JSONB,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at           TIMESTAMPTZ,
        coach_session_id      UUID
      );

      CREATE INDEX IF NOT EXISTS coach_candidate_campaign_status_idx
        ON "${schemaName}".coach_candidate_learnings (campaign_id, status);

      CREATE INDEX IF NOT EXISTS coach_candidate_campaign_created_idx
        ON "${schemaName}".coach_candidate_learnings (campaign_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS coach_candidate_run_idx
        ON "${schemaName}".coach_candidate_learnings (run_id);

      -- Race-safe idempotency: one candidate per (campaign, run, learning).
      CREATE UNIQUE INDEX IF NOT EXISTS coach_candidate_identity_idx
        ON "${schemaName}".coach_candidate_learnings (campaign_id, run_id, learning_id);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (106, 'Plan 183e §1 — coach_candidate_learnings ledger')
      ON CONFLICT (version) DO NOTHING;
    `);
}
