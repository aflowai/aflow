/**
 * Tenant migration 57 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration057(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".causal_measurements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        proposal_id TEXT NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        ratified_at TIMESTAMPTZ NOT NULL,
        baseline_window_start TIMESTAMPTZ NOT NULL,
        baseline_window_end TIMESTAMPTZ NOT NULL,
        post_window_start TIMESTAMPTZ NOT NULL,
        post_window_end TIMESTAMPTZ,
        baseline_metrics JSONB,
        post_metrics JSONB,
        delta_computed_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        UNIQUE (proposal_id)
      );
  
      CREATE INDEX IF NOT EXISTS causal_measurements_space_subject_idx
        ON "${schemaName}".causal_measurements (space_id, subject_kind, subject_id);
  
      CREATE INDEX IF NOT EXISTS causal_measurements_post_window_open_idx
        ON "${schemaName}".causal_measurements (post_window_end)
        WHERE post_window_end IS NULL;
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (57, 'Plan 104e Phase 5 — causal_measurements table')
      ON CONFLICT (version) DO NOTHING;
    `);

  // ---------------------------------------------------------------------------
}
