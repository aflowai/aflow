/**
 * Shared harness helpers — status checks, run loading, surface emits.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  loadRunById,
  emitWorkflowProgress,
  addAttentionItem,
  computeReadyTasksWithWhen,
  loadTaskOutputs,
  collectOutputReferencedTaskIds,
  materializeSkillTasks,
} from '@aflow/cybernetic-runtime';
import type {
  WorkflowRunDetail,
  WorkflowTaskRow,
  TaskOutputContext,
} from '@aflow/cybernetic-runtime';
import type { PayloadStore } from '@aflow/payload-store';
import type {
  TenantId,
  AttentionItemKind,
  Workflow,
  WorkflowHumanTaskHydration,
  WorkflowRunResult,
  WaiterNotifiedOutcome,
} from '@aflow/schemas';
import { StepOutputPresentationSchema, type StepOutputPresentation } from '@aflow/schemas';
import {
  resolveWorkflowForRunRevision,
  MissingPinnedRevisionError,
  createTenantContext,
  sessions,
  withTenantSchema,
} from '@aflow/database';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import type { HarnessDeps, NotifyWaitersArgs } from './types.js';

export async function computeReadyView(
  taskRows: WorkflowTaskRow[],
  workflow: Workflow,
  optionalTaskIds: Set<string>,
  payloadStore: PayloadStore | undefined,
): Promise<ReturnType<typeof computeReadyTasksWithWhen>> {
  const completedTaskIds = new Set(
    taskRows.filter((t) => t.status === 'succeeded').map((t) => t.taskId),
  );
  const skippedTaskIds = new Set(
    taskRows.filter((t) => t.status === 'skipped').map((t) => t.taskId),
  );
  const failedOptionalTaskIds = new Set(
    taskRows
      .filter((t) => t.status === 'failed' && optionalTaskIds.has(t.taskId))
      .map((t) => t.taskId),
  );
  const referencedTaskIds = collectOutputReferencedTaskIds(workflow.tasks);
  return computeReadyTasksWithWhen(
    workflow.tasks,
    completedTaskIds,
    skippedTaskIds,
    await buildTaskOutputContext(taskRows, payloadStore, referencedTaskIds),
    failedOptionalTaskIds,
  );
}

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'blocked', 'skipped', 'cancelled']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

/**
 * "Resting" includes terminal statuses AND `paused`. A paused row is
 * persisted state that another path already wrote; a duplicate
 * delivery must re-drive the post-record decision (notifyWaiters)
 * rather than re-calling pauseRunForTask, which would bump
 * pause_version and duplicate the attention row.
 */
export function isRestingTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status) || status === 'paused';
}

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function terminalStatusToAttentionKind(
  terminalStatus: 'completed' | 'failed' | 'cancelled',
): AttentionItemKind {
  switch (terminalStatus) {
    case 'completed':
      return 'workflow_run_completed';
    case 'failed':
      return 'workflow_run_failed';
    case 'cancelled':
      return 'workflow_run_cancelled';
  }
}

/**
 * `loadRunById` requires a spaceId. The intercepts get a runId only.
 * This helper reads the workflow_runs row directly to discover spaceId
 * + slug, then delegates back to `loadRunById` for the full detail.
 */
export async function loadRunByRunIdAcrossSpaces(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<WorkflowRunDetail | null> {
  const { workflowRuns, createTenantContext, withTenantSchema } = await import('@aflow/database');
  const { eq } = await import('drizzle-orm');
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const summaryRow = await withTenantSchema(db, tenantCtx, async (tx) => {
    const rows = await tx
      .select({ spaceId: workflowRuns.spaceId })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .limit(1);
    return rows[0];
  });
  if (!summaryRow) return null;
  return loadRunById(db, tenantId, summaryRow.spaceId, runId);
}

export function outcomeToRunStatus(
  outcome: NotifyWaitersArgs['outcome'],
): 'completed' | 'failed' | 'cancelled' | 'paused' | null {
  switch (outcome) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'paused':
      return 'paused';
    case 'handed_off':
      // `handed_off` is a waiter-level event (a takeover resume released
      // this waiter); the run-level state did not transition, so no
      // `WorkflowRunUpdate` is emitted.
      return null;
  }
}

/**
 * Map a persisted run-row terminal status to its `WaiterNotifiedOutcome`.
 * Returns `null` for non-terminal statuses (`running` / `paused`).
 *
 * Used by `cancelRun`'s fallback emit: when `completeRun` short-circuits
 * (run already terminal, or its terminal CAS lost to a concurrent
 * completion/failure), the cancel path must reflect the run's ACTUAL
 * persisted status — NOT assume `cancelled`. A cancel racing a normal
 * completion means the DB winner is `completed`/`failed`, and the UI must
 * be told that, not `cancelled`.
 */
export function runTerminalStatusToOutcome(status: string): WaiterNotifiedOutcome | null {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

export async function emitTaskUpdate(
  deps: HarnessDeps,
  args: {
    tenantId: TenantId;
    runId: string;
    taskId: string;
    label: string;
    status:
      | 'scheduled'
      | 'running'
      | 'succeeded'
      | 'failed'
      | 'paused'
      | 'blocked'
      | 'skipped'
      | 'cancelled';
    attempt: number;
    workerSessionId?: string;
    operationId?: string;
    /** Dispatch family — stamped so the chat surface can pick the task-row
     *  icon before BFF hydration. See `WorkflowTaskUpdatePayloadSchema`. */
    taskType?: 'agent' | 'operation' | 'human';
    startedAt?: Date | null;
    completedAt?: Date | null;
    failureReason?: string | null;
    summary?: string | null;
    presentation?: StepOutputPresentation;
    /**
     * Sanitized run-level state variables this task just promoted
     * (`resolveTaskPromotedState`) — lets the chat surface show output
     * values live, mid-run.
     */
    promotedState?: Record<string, unknown>;
    /**
     * Producer-rerun cleared this descendant row — live reducers drop it back
     * to a forward-DAG queued node. See `WorkflowTaskUpdatePayloadSchema`.
     */
    cleared?: true;
  } & Partial<
    Pick<
      WorkflowHumanTaskHydration,
      | 'humanIntent'
      | 'resolutionSchema'
      | 'actionPreview'
      | 'resumeContract'
      | 'pauseVersion'
      | 'failureMode'
    >
  >,
): Promise<void> {
  await emitWorkflowProgress(
    { db: deps.db, redis: deps.redis },
    {
      tenantId: args.tenantId as string,
      runId: args.runId,
      event: {
        kind: 'WorkflowTaskUpdate',
        payload: {
          runId: args.runId,
          taskId: args.taskId,
          label: args.label,
          status: args.status,
          attempt: args.attempt,
          ...(args.workerSessionId ? { workerSessionId: args.workerSessionId } : {}),
          ...(args.operationId ? { operationId: args.operationId } : {}),
          ...(args.taskType ? { taskType: args.taskType } : {}),
          ...(args.startedAt ? { startedAt: args.startedAt.toISOString() } : {}),
          ...(args.completedAt ? { completedAt: args.completedAt.toISOString() } : {}),
          ...(args.failureReason ? { failureReason: args.failureReason } : {}),
          ...(args.summary ? { summary: args.summary } : {}),
          ...(args.presentation ? { presentation: args.presentation } : {}),
          ...(args.promotedState ? { promotedState: args.promotedState } : {}),
          ...(args.humanIntent ? { humanIntent: args.humanIntent } : {}),
          ...(args.resolutionSchema ? { resolutionSchema: args.resolutionSchema } : {}),
          ...(args.actionPreview ? { actionPreview: args.actionPreview } : {}),
          ...(args.resumeContract !== undefined ? { resumeContract: args.resumeContract } : {}),
          ...(args.pauseVersion !== undefined ? { pauseVersion: args.pauseVersion } : {}),
          ...(args.failureMode ? { failureMode: args.failureMode } : {}),
          ...(args.cleared ? { cleared: args.cleared } : {}),
        },
      },
    },
  );
}

export async function extractPresentationFromOutput(
  payloadStore: PayloadStore,
  outputRef: string | null | undefined,
): Promise<StepOutputPresentation | undefined> {
  if (!outputRef) return undefined;
  try {
    const raw = await payloadStore.retrieve(outputRef);
    if (!raw || typeof raw !== 'object') return undefined;
    const candidate = (raw as Record<string, unknown>)['presentation'];
    if (!candidate) return undefined;
    const parsed = StepOutputPresentationSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function emitTerminalRunUpdate(
  deps: HarnessDeps,
  args: NotifyWaitersArgs,
  /**
   * Structured run result for terminal transitions — the same object the
   * waiter wakeup envelope carries (built once in `notifyWaiters` via
   * `buildWorkflowRunDetail`). The chat surface renders its outcome block
   * from this without waiting for BFF hydration.
   */
  result?: WorkflowRunResult,
): Promise<void> {
  const status = outcomeToRunStatus(args.outcome);
  if (status === null) return; // handed_off — no run-level transition
  const tenantIdStr = args.tenantId as string;
  // Reuse pre-loaded run when caller passed one; otherwise load fresh.
  const run =
    args.runDetail ?? (await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, args.runId));
  if (!run) return;

  await emitWorkflowProgress(
    { db: deps.db, redis: deps.redis },
    {
      tenantId: tenantIdStr,
      runId: args.runId,
      event: {
        kind: 'WorkflowRunUpdate',
        payload: {
          runId: args.runId,
          slug: run.workflowSlug,
          status,
          pauseVersion: run.pauseVersion,
          ...(run.pausedReason ? { pausedReason: run.pausedReason } : {}),
          startedAt: run.startedAt.toISOString(),
          ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
          ...(result ? { result } : {}),
        },
      },
      // Honor handoff-style exclusions so the just-added new waiter
      // doesn't receive the run-update either.
      ...(args.excludeSessionIds ? { excludeSessionIds: args.excludeSessionIds } : {}),
    },
  );
}

/**
 * Bump `workflow_runs.scheduler_cursor_version` to mark "the run advanced".
 * Read by the sweeper to detect that scheduling work is fresh; bumped on
 * every task-result write so the version reflects causal progress.
 */
export async function bumpSchedulerCursorVersion(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<void> {
  const { workflowRuns, createTenantContext, withTenantSchema } = await import('@aflow/database');
  const { eq, sql } = await import('drizzle-orm');
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .update(workflowRuns)
      .set({
        schedulerCursorVersion: sql`${workflowRuns.schedulerCursorVersion} + 1`,
      })
      .where(eq(workflowRuns.runId, runId));
  });
}

export async function resolveWorkflowForRun(
  db: PostgresJsDatabase,
  tenantId: string,
  run: WorkflowRunDetail,
): Promise<Workflow | null> {
  try {
    const resolved = await resolveWorkflowForRunRevision(
      db,
      tenantId as TenantId,
      run.spaceId,
      run.workflowSlug,
      run.workflowRevision,
    );
    const materializedTasks = materializeSkillTasks(resolved.workflow.tasks);
    return { ...resolved.workflow, tasks: materializedTasks };
  } catch (err) {
    if (err instanceof MissingPinnedRevisionError) {
      logOrchestratorError(
        `[WorkflowRunHarness] missing pinned revision for run=${run.runId} slug=${run.workflowSlug} rev=${String(run.workflowRevision)}`,
        err,
        {
          tenantId,
          runId: run.runId,
          slug: run.workflowSlug,
          revision: run.workflowRevision,
        },
      );
      return null;
    }
    throw err;
  }
}

export async function buildTaskOutputContext(
  taskRows: WorkflowTaskRow[],
  payloadStore: PayloadStore | undefined,
  onlyReferencedTaskIds?: Set<string>,
): Promise<TaskOutputContext> {
  const statuses = new Map<string, string>();
  for (const row of taskRows) {
    statuses.set(row.taskId, row.status);
  }
  if (onlyReferencedTaskIds?.size === 0) {
    // No output-based predicates anywhere in the workflow — no decode needed.
    return { statuses, outputs: new Map() };
  }
  const filteredRows = onlyReferencedTaskIds
    ? taskRows.filter((row) => onlyReferencedTaskIds.has(row.taskId))
    : taskRows;
  const outputs = await loadTaskOutputs(filteredRows, payloadStore);
  return { statuses, outputs };
}

/**
 * Append an attention_items row using the trusted tenantId. Wrapper
 * around the ledger helper; ensures spaceId / userId are derived from
 * the run row consistently.
 */
export async function writeAttentionItem(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  run: WorkflowRunDetail,
  kind: AttentionItemKind,
  payload: Record<string, unknown>,
  tx?: PostgresJsDatabase,
): Promise<void> {
  await addAttentionItem(
    db,
    tenantId as string,
    {
      spaceId: run.spaceId,
      kind,
      relatedRunId: run.runId,
      relatedResource: `workflow_run:${run.runId}`,
      payload,
      priority: 0,
    },
    tx,
  );
}

/**
 * Whose credentials a session's work runs under, read from the durable row.
 *
 * The hot copy carries this too, but hot state expires after a day while a
 * parked session and its schedules do not — so work that fires later would
 * otherwise dispatch with no credential owner and fail on its first model
 * call, or re-pause on consent forever.
 */
export async function readDurableSessionCreatedBy(
  db: PostgresJsDatabase,
  tenantId: string,
  sessionId: string,
): Promise<string | undefined> {
  const { eq } = await import('drizzle-orm');
  try {
    const rows = await withTenantSchema(db, createTenantContext(tenantId as TenantId), async (tx) =>
      tx
        .select({ createdBy: sessions.createdBy })
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1),
    );
    return rows[0]?.createdBy ?? undefined;
  } catch (err) {
    logOrchestratorError('[harness] durable createdBy lookup failed', err, {
      tenantId,
      sessionId,
    });
    return undefined;
  }
}
