/**
 * Tenant migration 14 — pre-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration014(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".eval_suites (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        suite_id        TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        description     TEXT,
        target          JSONB NOT NULL,
        tasks           JSONB NOT NULL,
        graders         JSONB NOT NULL,
        run_policy      JSONB NOT NULL,
        baseline_run_id TEXT,
        tags            TEXT[],
        space_id        UUID,
        created_by      TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
  
      CREATE TABLE IF NOT EXISTS "${schemaName}".eval_runs (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        eval_run_id     TEXT NOT NULL UNIQUE,
        suite_id        TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'running',
        task_results    JSONB,
        summary         JSONB,
        regression      JSONB,
        started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_eval_runs_suite ON "${schemaName}".eval_runs(suite_id);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_status ON "${schemaName}".eval_runs(status);
  
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (14, 'Plan 38 Phase 2 — eval suites + eval runs')
      ON CONFLICT (version) DO NOTHING;
    `);
}
