/**
 * The durable half of a dry run: whether a run is one, which sessions work for
 * it, and the writes it held.
 */
import { asc, eq } from 'drizzle-orm';
import type { DryRunHeldWrite, TenantId, WorkflowRunHeldWrite } from '@aflow/schemas';
import type { Database } from '../database.js';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';
import {
  workflowRunDryRunSessions,
  workflowRunHeldWrites,
  workflowRuns,
} from '../schema/tenant/workflows.js';

export class WorkflowRunNotFoundForDryRun extends Error {
  constructor(runId: string) {
    super(
      `Workflow run ${runId} has no row, so whether it is a dry run cannot be read. The write was not sent.`,
    );
    this.name = 'WorkflowRunNotFoundForDryRun';
  }
}

/**
 * Whether `runId` is a dry run. A run with no row throws rather than answering
 * false, so a write whose run cannot be read is never sent as a live one.
 */
export async function readWorkflowRunDryRun(
  db: Database,
  tenantId: TenantId,
  runId: string,
): Promise<boolean> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .select({ dryRun: workflowRuns.dryRun })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .limit(1),
  );
  const row = rows[0];
  if (row === undefined) throw new WorkflowRunNotFoundForDryRun(runId);
  return row.dryRun;
}

/** The dry run a session works for, as its durable link records it. */
export interface DryRunSessionLink {
  runId: string;
  taskId?: string;
}

/**
 * Link a session to the dry run it works for. Written before the session's
 * hot state exists, so no step of it can dispatch before the link is durable.
 * A second link of the same session keeps the first.
 */
export async function recordDryRunSession(
  db: Database,
  tenantId: TenantId,
  params: { sessionId: string; runId: string; taskId?: string | undefined },
): Promise<void> {
  await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .insert(workflowRunDryRunSessions)
      .values({
        sessionId: params.sessionId,
        runId: params.runId,
        ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
      })
      .onConflictDoNothing(),
  );
}

/**
 * The dry run `sessionId` works for, or null when it works for none. Every
 * dry-run session is linked before its hot state exists, so no link means a
 * live session. A failed read throws, and the caller must not dispatch.
 */
export async function readDryRunSession(
  db: Database,
  tenantId: TenantId,
  sessionId: string,
): Promise<DryRunSessionLink | null> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .select({ runId: workflowRunDryRunSessions.runId, taskId: workflowRunDryRunSessions.taskId })
      .from(workflowRunDryRunSessions)
      .where(eq(workflowRunDryRunSessions.sessionId, sessionId))
      .limit(1),
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { runId: row.runId, ...(row.taskId !== null ? { taskId: row.taskId } : {}) };
}

export interface RecordDryRunHeldWriteParams {
  held: DryRunHeldWrite;
  stepExecutionId: string;
  attempt: number;
  taskId?: string | undefined;
  sessionId?: string | undefined;
}

/** Record one held write. A redelivered result for the same step attempt records nothing. */
export async function recordDryRunHeldWrite(
  db: Database,
  tenantId: TenantId,
  params: RecordDryRunHeldWriteParams,
): Promise<void> {
  await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .insert(workflowRunHeldWrites)
      .values({
        runId: params.held.runId,
        operationId: params.held.operationId,
        target: params.held.target,
        stepExecutionId: params.stepExecutionId,
        attempt: params.attempt,
        ...(params.held.preview !== undefined ? { preview: params.held.preview } : {}),
        ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
        ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      })
      .onConflictDoNothing(),
  );
}

/** Every write a dry run held, oldest first. */
export async function listDryRunHeldWrites(
  db: Database,
  tenantId: TenantId,
  runId: string,
): Promise<WorkflowRunHeldWrite[]> {
  const rows = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .select()
      .from(workflowRunHeldWrites)
      .where(eq(workflowRunHeldWrites.runId, runId))
      .orderBy(asc(workflowRunHeldWrites.heldAt), asc(workflowRunHeldWrites.id)),
  );
  return rows.map((row) => ({
    runId: row.runId,
    operationId: row.operationId,
    target: row.target,
    stepExecutionId: row.stepExecutionId,
    heldAt: row.heldAt.toISOString(),
    ...(row.preview !== null ? { preview: row.preview } : {}),
    ...(row.taskId !== null ? { taskId: row.taskId } : {}),
    ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
  }));
}
