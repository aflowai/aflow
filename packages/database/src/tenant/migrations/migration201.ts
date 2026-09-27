import type postgres from 'postgres';

/**
 * Store a trial's outcome class rather than letting each surface derive one.
 *
 * `verdict` carries three values and every reader folded them differently: the
 * tab's rollup counted an execution error as a behavioural failure, comparison
 * excluded it, and the stratum score nothing produced would have done a third
 * thing. The class is written once by the grader and read everywhere, and the
 * aggregation version beside it says which rule produced a given row — so
 * changing the rule is an explicit recompute instead of a silent divergence.
 */
export async function applyMigration201(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ALTER TABLE "${schemaName}".eval_case_results
        ADD COLUMN IF NOT EXISTS outcome_class TEXT,
        ADD COLUMN IF NOT EXISTS aggregation_version TEXT;

      CREATE INDEX IF NOT EXISTS eval_case_results_outcome_idx
        ON "${schemaName}".eval_case_results (batch_id, outcome_class)
        WHERE outcome_class IS NOT NULL;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (201, 'eval_case_results.outcome_class + aggregation_version — one stored fold, not four derivations')
      ON CONFLICT (version) DO NOTHING;
    `);
}
