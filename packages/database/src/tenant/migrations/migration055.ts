/**
 * Tenant migration 55 — post-taxonomy
 */
import type postgres from 'postgres';

export async function applyMigration055(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".eval_judge_calibration (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        eval_suite_path TEXT NOT NULL,
        criterion_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        human_label TEXT NOT NULL,
        judge_label TEXT NOT NULL,
        judge_score NUMERIC(3,2),
        run_id TEXT NOT NULL,
        note TEXT,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        recorded_by_user_id UUID,
        UNIQUE (space_id, eval_suite_path, criterion_id, scope_key, run_id)
      );
  
      CREATE INDEX IF NOT EXISTS eval_judge_calibration_crit_idx
        ON "${schemaName}".eval_judge_calibration (space_id, eval_suite_path, criterion_id, scope_key);
  
      DELETE FROM "${schemaName}".schema_migrations WHERE version = 55;
      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (55, 'Plan 104e Phase 1 — eval_judge_calibration table with scope_key');
    `);
}
