import type postgres from 'postgres';

export async function applyMigration164(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".eval_label_queue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        batch_id UUID NOT NULL,
        case_revision_id UUID NOT NULL,
        trial INTEGER NOT NULL,
        run_id TEXT,
        criterion_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        partition TEXT NOT NULL,
        source TEXT NOT NULL,
        inclusion_probability NUMERIC(7,6),
        judge_version TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        label_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at TIMESTAMPTZ,
        UNIQUE (batch_id, case_revision_id, trial, criterion_id, scope_key)
      );

      CREATE INDEX IF NOT EXISTS eval_label_queue_pending_idx
        ON "${schemaName}".eval_label_queue (space_id, status, created_at);
      CREATE INDEX IF NOT EXISTS eval_label_queue_batch_idx
        ON "${schemaName}".eval_label_queue (batch_id);

      CREATE TABLE IF NOT EXISTS "${schemaName}".eval_rejudge_verdicts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        batch_id UUID NOT NULL,
        case_revision_id UUID NOT NULL,
        trial INTEGER NOT NULL,
        run_id TEXT,
        criterion_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        judge_version TEXT NOT NULL,
        judge_model TEXT NOT NULL,
        verdict TEXT NOT NULL,
        rationale TEXT NOT NULL,
        score NUMERIC(3,2),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (batch_id, case_revision_id, trial, criterion_id, scope_key, judge_version)
      );

      CREATE INDEX IF NOT EXISTS eval_rejudge_verdicts_batch_idx
        ON "${schemaName}".eval_rejudge_verdicts (batch_id, criterion_id);

      ALTER TABLE "${schemaName}".eval_batches
        ADD COLUMN IF NOT EXISTS validation_slice_size INTEGER NOT NULL DEFAULT 0;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (164, 'Plan 269 P3 — eval_label_queue, eval_rejudge_verdicts, eval_batches.validation_slice_size')
      ON CONFLICT (version) DO NOTHING;
    `);
}
