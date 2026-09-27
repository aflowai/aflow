import type postgres from 'postgres';
import {
  workflowRunDuePointerDdl,
  workflowRunDueSeedDdl,
  workflowRunDueTriggerDdl,
} from '../workflowRunDue.js';

/**
 * Attach this tenant's workflow tables to the cross-tenant due pointer.
 *
 * The pointer DDL is re-emitted here so a schema provisioned at signup arms
 * from its first write: the trigger body resolves its target at execution
 * time, so a missing table surfaces as a failed workflow write rather than a
 * failed migration.
 */
export async function applyMigration168(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ${workflowRunDuePointerDdl()}

      ${workflowRunDueTriggerDdl(schemaName)}

      -- The recompute takes a min() over running runs; without this the settle
      -- scans the tenant's whole run history while holding the pointer row that
      -- every workflow write now has to take.
      CREATE INDEX IF NOT EXISTS workflow_runs_scheduler_deadline_idx
        ON "${schemaName}".workflow_runs (scheduler_cursor_deadline)
        WHERE status = 'running' AND scheduler_cursor_deadline IS NOT NULL;

      ${workflowRunDueSeedDdl(schemaName)}

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (168, 'Arm the cross-tenant workflow-run due pointer from this schema''s run and completion-pending rows')
      ON CONFLICT (version) DO NOTHING;
    `);
}
