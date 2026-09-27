import type postgres from 'postgres';
import {
  workflowRunDuePointerDdl,
  workflowRunDueSeedDdl,
  workflowRunDueTriggerDdl,
} from '../workflowRunDue.js';

/**
 * Arm the workflow-run due pointer from terminal runs still owed an evaluation
 * envelope, so the repair for a worker that died between the terminal write and
 * the post-run hook is discoverable at all.
 *
 * The trigger DDL is re-emitted whole — it drops and recreates every source's
 * trigger — so the schema ends up with exactly the sources the pointer declares.
 *
 * The seed matters more here than for the other sources: a run that is already
 * terminal is written again only by the repair itself, so without it every run
 * stranded before this migration stays stranded, and the pre-envelope history
 * this tenant carries is never drained.
 */
export async function applyMigration182(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ${workflowRunDuePointerDdl()}

      ${workflowRunDueTriggerDdl(schemaName)}

      -- The settle takes a min() over this predicate while holding the pointer
      -- row every workflow write has to take, and the repair's own candidate
      -- query reads it in the same order.
      CREATE INDEX IF NOT EXISTS workflow_runs_missing_evaluation_idx
        ON "${schemaName}".workflow_runs (completed_at)
        WHERE status IN ('completed', 'failed', 'cancelled') AND evaluation_json IS NULL;

      ${workflowRunDueSeedDdl(schemaName)}

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (182, 'Arm the workflow-run due pointer from terminal runs missing an evaluation envelope')
      ON CONFLICT (version) DO NOTHING;
    `);
}
