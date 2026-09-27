import type postgres from 'postgres';
import {
  evalBatchDuePointerDdl,
  evalBatchDueSeedDdl,
  evalBatchDueTriggerDdl,
} from '../evalBatchDue.js';

/**
 * Attach this tenant's eval batches and ephemeral fixture spaces to the
 * cross-tenant due pointer.
 *
 * The pointer DDL is re-emitted here so a schema provisioned at signup arms
 * from its first write: the trigger body resolves its target at execution time,
 * so a missing table surfaces as a failed source write rather than a failed
 * migration.
 *
 * The seed is in the same statement as the triggers because the trigger alone
 * would arm nothing for the batches that matter most. A queued or running batch
 * is written again only by the engine, and that write is the work the pointer
 * exists to cause — install without seeding and every batch in flight stalls
 * permanently rather than merely late, with its fixture spaces never collected.
 */
export async function applyMigration181(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ${evalBatchDuePointerDdl()}

      ${evalBatchDueTriggerDdl(schemaName)}

      -- Each settle takes a min() over its source's due predicate while holding
      -- the pointer row every write to that source now has to take. Without a
      -- covering index the recompute scans the whole table under that lock.
      -- Fixture spaces already have one from the expiry column itself
      -- (spaces_expires_at_idx), which is the same predicate.
      CREATE INDEX IF NOT EXISTS eval_batches_needing_work_idx
        ON "${schemaName}".eval_batches (created_at)
        WHERE status IN ('queued', 'running', 'cancelling');

      ${evalBatchDueSeedDdl(schemaName)}

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (181, 'Arm the cross-tenant eval-batch due pointer from this schema''s batch and fixture-space rows')
      ON CONFLICT (version) DO NOTHING;
    `);
}
