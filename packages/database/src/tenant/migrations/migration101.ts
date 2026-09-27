import type postgres from 'postgres';

export async function applyMigration101(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".coach_activity (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id               UUID NOT NULL,
        coach_session_id       TEXT,
        skill_slug             TEXT,
        trigger_kind           TEXT NOT NULL,
        trigger_cause          TEXT,
        evidence_tier          TEXT NOT NULL,
        intervention_level     TEXT NOT NULL,
        outcome                TEXT NOT NULL,
        status                 TEXT NOT NULL,
        proposal_count         INTEGER NOT NULL DEFAULT 0,
        observation_count      INTEGER NOT NULL DEFAULT 0,
        learning_count         INTEGER NOT NULL DEFAULT 0,
        preview_failed_count   INTEGER NOT NULL DEFAULT 0,
        bypasses_gate          BOOLEAN NOT NULL DEFAULT FALSE,
        cost_cents             NUMERIC(12,4),
        duration_ms            INTEGER,
        context_doc_path       TEXT,
        facts_doc_path         TEXT,
        rationale              TEXT,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS coach_activity_session_idx
        ON "${schemaName}".coach_activity (space_id, coach_session_id);

      CREATE INDEX IF NOT EXISTS coach_activity_space_created_idx
        ON "${schemaName}".coach_activity (space_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS coach_activity_skill_created_idx
        ON "${schemaName}".coach_activity (space_id, skill_slug, created_at DESC);

      CREATE INDEX IF NOT EXISTS coach_activity_outcome_idx
        ON "${schemaName}".coach_activity (space_id, outcome, created_at DESC);

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (101, 'Plan 163 §13.2.2 Phase 5a — coach_activity projection table')
      ON CONFLICT (version) DO NOTHING;
    `);
}
