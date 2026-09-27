import type postgres from 'postgres';

export async function applyMigration159(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".golden_datasets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        workflow_slug TEXT NOT NULL,
        dataset_version INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (space_id, workflow_slug)
      );

      CREATE TABLE IF NOT EXISTS "${schemaName}".golden_case_revisions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        dataset_id UUID NOT NULL,
        case_id UUID NOT NULL,
        added_in_version INTEGER NOT NULL,
        removed_in_version INTEGER,
        status TEXT NOT NULL,
        tier TEXT NOT NULL,
        direction TEXT NOT NULL,
        scenario TEXT NOT NULL,
        source TEXT NOT NULL,
        workflow_revision INTEGER NOT NULL,
        title TEXT NOT NULL,
        notes TEXT,
        trigger_json JSONB NOT NULL,
        fixture_json JSONB NOT NULL,
        expectations_json JSONB NOT NULL DEFAULT '[]',
        rubrics_json JSONB NOT NULL DEFAULT '[]',
        provenance_json JSONB NOT NULL,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (dataset_id, case_id, added_in_version)
      );

      CREATE INDEX IF NOT EXISTS golden_case_revisions_dataset_idx
        ON "${schemaName}".golden_case_revisions (dataset_id, added_in_version);
      CREATE INDEX IF NOT EXISTS golden_case_revisions_case_idx
        ON "${schemaName}".golden_case_revisions (dataset_id, case_id);

      CREATE TABLE IF NOT EXISTS "${schemaName}".eval_labels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        run_id TEXT NOT NULL,
        case_revision_id UUID,
        batch_id UUID,
        trial INTEGER,
        eval_suite_path TEXT,
        criterion_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        verdict TEXT NOT NULL,
        judge_label TEXT,
        judge_score NUMERIC(3,2),
        critique TEXT NOT NULL,
        judge_version TEXT,
        partition TEXT NOT NULL,
        labeled_by_user_id UUID NOT NULL,
        labeled_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS eval_labels_run_scoped_idx
        ON "${schemaName}".eval_labels (space_id, criterion_id, scope_key, run_id)
        WHERE case_revision_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS eval_labels_case_scoped_idx
        ON "${schemaName}".eval_labels (space_id, case_revision_id, trial, criterion_id, scope_key)
        WHERE case_revision_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS eval_labels_crit_idx
        ON "${schemaName}".eval_labels (space_id, criterion_id, scope_key);
      CREATE INDEX IF NOT EXISTS eval_labels_case_idx
        ON "${schemaName}".eval_labels (case_revision_id);

      DROP TABLE IF EXISTS "${schemaName}".eval_judge_calibration;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (159, 'Plan 269 P1 — golden_datasets, golden_case_revisions, eval_labels (absorbs eval_judge_calibration)')
      ON CONFLICT (version) DO NOTHING;
    `);
}
