import type postgres from 'postgres';
import {
  MEMORY_EMBED_DUE_POINTER,
  OAUTH_STATE_DUE_POINTER,
  SCHEDULE_DUE_POINTER,
} from '../duePointers.js';
import { tenantDuePointerDdl, tenantDueSeedDdl, tenantDueTriggerDdl } from '../tenantDue.js';

const POINTERS = [SCHEDULE_DUE_POINTER, OAUTH_STATE_DUE_POINTER, MEMORY_EMBED_DUE_POINTER];

/**
 * Attach this tenant's schedules, OAuth consent state, and memory documents to
 * their cross-tenant due pointers.
 *
 * The pointer DDL is re-emitted here so a schema provisioned at signup arms
 * from its first write: the trigger body resolves its target at execution time,
 * so a missing table surfaces as a failed source write rather than a failed
 * migration.
 *
 * The seed is in the same statement as the triggers because for two of these
 * three the trigger alone would arm nothing. An active cron schedule's row is
 * written only by the evaluator when it fires, and the fire is what the pointer
 * exists to cause — install without seeding and every healthy schedule in every
 * tenant goes silent permanently rather than merely slowly.
 */
export async function applyMigration170(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      ${POINTERS.map((pointer) => tenantDuePointerDdl(pointer)).join('\n')}

      ${POINTERS.map((pointer) => tenantDueTriggerDdl(pointer, schemaName)).join('\n')}

      -- Each settle takes a min() over its source's due predicate while holding
      -- the pointer row every write to that source now has to take. Without a
      -- covering index the recompute scans the whole table under that lock.
      -- Schedules already have one from the evaluator's original poll
      -- (idx_agent_schedules_next_fire), which is the same predicate.
      CREATE INDEX IF NOT EXISTS oauth_state_expires_idx
        ON "${schemaName}".oauth_state (expires_at);

      CREATE INDEX IF NOT EXISTS memory_docs_embed_pending_idx
        ON "${schemaName}".memory_docs (updated_at)
        WHERE deleted_at IS NULL AND embedding_status = 'pending' AND indexing_mode <> 'disabled';

      ${POINTERS.map((pointer) => tenantDueSeedDdl(pointer, schemaName)).join('\n')}

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (170, 'Arm the schedule, OAuth-state, and memory-embed due pointers from this schema''s rows')
      ON CONFLICT (version) DO NOTHING;
    `);
}
