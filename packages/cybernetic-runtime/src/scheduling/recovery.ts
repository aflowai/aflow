import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, sql } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
} from '@aflow/database';

/** Default stalled-after threshold in milliseconds. */
export const DEFAULT_STALLED_AFTER_MS = 60_000; // 60 seconds

/**
 * Stamp the scheduler cursor and deadline on a run after a scheduling pass.
 *
 * Called at the end of every scheduling pass. The deadline is `now + stalledAfterMs`.
 * If the deadline expires without another pass, the run is considered stalled
 * and a recovery pass is triggered.
 */
export async function stampSchedulerDeadline(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  stalledAfterMs: number = DEFAULT_STALLED_AFTER_MS,
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const now = new Date();
  const deadline = new Date(now.getTime() + stalledAfterMs);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .update(workflowRuns)
      .set({
        schedulerCursorAt: now,
        schedulerCursorDeadline: deadline,
      })
      .where(eq(workflowRuns.runId, runId));
  });
}

/**
 * Recovery pass: find task rows in 'scheduled' state that have been stranded
 * (no step execution picked them up) and delete them so they can be re-claimed.
 *
 * Called when a run's scheduler_cursor_deadline expires. Returns the count
 * of recovered (released) task rows.
 */
export async function runRecoveryPass(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<number> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    // Find scheduled rows with no step_execution_id — these are orphaned claims.
    // Delete them so a future scheduling pass can re-claim.
    const result = await tx
      .delete(workflowRunTasks)
      .where(
        and(
          eq(workflowRunTasks.runId, runId),
          eq(workflowRunTasks.status, 'scheduled'),
          sql`${workflowRunTasks.stepExecutionId} IS NULL`,
        ),
      )
      .returning({ id: workflowRunTasks.id });

    return result.length;
  });
}

/**
 * Find runs with expired scheduler_cursor_deadline (backstop sweep).
 * Returns run IDs that need a recovery pass.
 */
export async function findStalledRuns(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  opts: { limit: number },
): Promise<string[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({ runId: workflowRuns.runId })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.spaceId, spaceId),
          eq(workflowRuns.status, 'running'),
          sql`${workflowRuns.schedulerCursorDeadline} IS NOT NULL`,
          sql`${workflowRuns.schedulerCursorDeadline} < now()`,
        ),
      )
      .limit(opts.limit);

    return rows.map((r) => r.runId);
  });
}

/**
 * Tenant-wide variant of {@link findStalledRuns} — every space the tenant
 * owns. The orphaned-run reconciler scans per tenant (matching the
 * completion-pending sweeper), so it needs the space-agnostic query.
 */
export async function findStalledRunsAcrossSpaces(
  db: PostgresJsDatabase,
  tenantId: string,
  opts: { limit: number },
): Promise<string[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({ runId: workflowRuns.runId })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.status, 'running'),
          sql`${workflowRuns.schedulerCursorDeadline} IS NOT NULL`,
          sql`${workflowRuns.schedulerCursorDeadline} < now()`,
        ),
      )
      .limit(opts.limit);

    return rows.map((r) => r.runId);
  });
}
