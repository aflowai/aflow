import type postgres from 'postgres';

export async function applyMigration161(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".eval_batches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        workflow_slug TEXT NOT NULL,
        dataset_id UUID NOT NULL,
        dataset_version INTEGER NOT NULL,
        workflow_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        trials_per_case INTEGER NOT NULL,
        max_concurrent_trials INTEGER NOT NULL,
        cost_ceiling_cents INTEGER NOT NULL,
        cost_spent_cents INTEGER NOT NULL DEFAULT 0,
        provenance_manifest_json JSONB NOT NULL,
        summary_json JSONB,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS eval_batches_space_workflow_idx
        ON "${schemaName}".eval_batches (space_id, workflow_slug, created_at);
      CREATE INDEX IF NOT EXISTS eval_batches_status_idx
        ON "${schemaName}".eval_batches (status);

      CREATE TABLE IF NOT EXISTS "${schemaName}".eval_batch_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id UUID NOT NULL,
        case_revision_id UUID NOT NULL,
        UNIQUE (batch_id, case_revision_id)
      );

      CREATE TABLE IF NOT EXISTS "${schemaName}".eval_case_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id UUID NOT NULL,
        case_revision_id UUID NOT NULL,
        trial INTEGER NOT NULL,
        run_id TEXT,
        disposition TEXT NOT NULL,
        results_json JSONB,
        verdict TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        duration_ms INTEGER,
        cost_cents INTEGER,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        attempt INTEGER NOT NULL DEFAULT 0,
        UNIQUE (batch_id, case_revision_id, trial)
      );

      CREATE INDEX IF NOT EXISTS eval_case_results_batch_idx
        ON "${schemaName}".eval_case_results (batch_id, disposition);
      CREATE INDEX IF NOT EXISTS eval_case_results_run_idx
        ON "${schemaName}".eval_case_results (run_id);

      ALTER TABLE "${schemaName}".workflow_runs
        ADD COLUMN IF NOT EXISTS eval_batch_id TEXT;

      CREATE INDEX IF NOT EXISTS workflow_runs_eval_batch_idx
        ON "${schemaName}".workflow_runs (eval_batch_id)
        WHERE eval_batch_id IS NOT NULL;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (161, 'Plan 269 P2 — eval_batches, eval_batch_members, eval_case_results; workflow_runs.eval_batch_id frozen-mode marker')
      ON CONFLICT (version) DO NOTHING;
    `);
}
