import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { SimulationRunInput, TrialExecutionState } from '@aflow/schemas';
import { eq, and, inArray, sql } from 'drizzle-orm';
import type { SkillConcurrencyPolicy, TenantId, WorkflowRunCancellation } from '@aflow/schemas';
import { createTenantContext, withTenantSchema, workflowRuns, memoryDocs } from '@aflow/database';
import { DEFAULT_STALLED_AFTER_MS } from '../scheduling/recovery.js';

export interface RecordRunStartParams {
  spaceId: string;
  workflowSlug: string;
  runId: string;
  sessionId?: string;
  workflowRevision: number;
  startedAt: Date;
  /** 104d Phase 3: user who initiated this run. NULL for system/platform runs. */
  initiatedByUserId?: string | undefined;
  campaignId?: string | undefined;
  /** Plan 269 D5 — set ONLY by the eval-batch launcher; marks a frozen trial. */
  evalBatchId?: string | undefined;
  /**
   * Simulation pins the Runner sessions this run spawns must inherit. Held on
   * the run because those sessions start later, each with its own session
   * state — a workflow told to act as one persona would otherwise run its
   * tasks as whatever each simulation defaults to.
   */
  simulationRunInput?: SimulationRunInput | undefined;
  /**
   * agentId → version this run must execute. Dispatch resolves `latest`
   * without one, so a measured run records a pin here or its manifest
   * describes a subject it did not necessarily run.
   */
  agentVersionPins?: Record<string, string> | undefined;
  /**
   * Concurrency policy to freeze on the run row. Omitted for runs with no
   * skill manifest (platform/inline); readers then fall back to the schema
   * defaults.
   */
  effectiveConcurrencyPolicy?: SkillConcurrencyPolicy | undefined;
  metadata?: Record<string, unknown>;
}

export class WorkflowArchivedError extends Error {
  readonly code = 'WORKFLOW_ARCHIVED' as const;
  readonly workflowSlug: string;
  constructor(workflowSlug: string) {
    super(
      `Workflow '${workflowSlug}' is archived — cannot start a new run. ` +
        `Unarchive the skill first or pick a different skill.`,
    );
    this.name = 'WorkflowArchivedError';
    this.workflowSlug = workflowSlug;
  }
}

export async function recordRunStart(
  db: PostgresJsDatabase,
  tenantId: string,
  params: RecordRunStartParams,
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    // Acquire sentinel lock + check archive state. Includes soft-deleted
    // rows (the lock also serves as the archive read fence).
    const lockResult = await tx
      .select({ deletedAt: memoryDocs.deletedAt })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, params.spaceId),
          eq(memoryDocs.path, `/workflows/${params.workflowSlug}/workflow.json`),
        ),
      )
      .for('update')
      .limit(1);

    const lockRow = lockResult[0];
    if (lockRow && lockRow.deletedAt !== null) {
      throw new WorkflowArchivedError(params.workflowSlug);
    }
    // No row → platform/legacy/inline run; no lock to take, proceed.

    // Arm the supervision clock at creation. The first scheduling pass
    // re-stamps it (stampSchedulerDeadline), but if the run dies before that
    // pass ever happens — orchestrator restart mid-start, or any failure in
    // the window between this insert and the first task dispatch — the
    // deadline still expires, so the orphaned-run reconciler can see it.
    // A NULL deadline is invisible to findStalledRuns and the run becomes a
    // permanent zombie that also pins the per-workflow concurrency slot.
    await tx.insert(workflowRuns).values({
      spaceId: params.spaceId,
      workflowSlug: params.workflowSlug,
      runId: params.runId,
      sessionId: params.sessionId,
      status: 'running',
      workflowRevision: params.workflowRevision,
      startedAt: params.startedAt,
      schedulerCursorAt: params.startedAt,
      schedulerCursorDeadline: new Date(params.startedAt.getTime() + DEFAULT_STALLED_AFTER_MS),
      ...(params.initiatedByUserId ? { initiatedByUserId: params.initiatedByUserId } : {}),
      ...(params.campaignId ? { campaignId: params.campaignId } : {}),
      ...(params.evalBatchId ? { evalBatchId: params.evalBatchId } : {}),
      ...(params.simulationRunInput ? { simulationRunInputJson: params.simulationRunInput } : {}),
      ...(params.agentVersionPins ? { agentVersionPins: params.agentVersionPins } : {}),
      ...(params.effectiveConcurrencyPolicy
        ? { effectiveConcurrencyPolicy: params.effectiveConcurrencyPolicy }
        : {}),
      metadata: params.metadata ?? {},
    });
  });
}

export interface CompleteRunParams {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  completedAt: Date;
  totalCostCents?: number;
  totalTokens?: number;
  failureJson?: unknown;
  learningsJson?: unknown;
  /**
   * Cancellation provenance — only meaningful with `status: 'cancelled'`.
   * Stamps `cancelled_by` / `cancel_reason` on the run row so post-run
   * hooks and read surfaces can distinguish a deliberate operator stop
   * from agent/system teardown.
   */
  cancellation?: WorkflowRunCancellation;
}

export async function completeRun(
  db: PostgresJsDatabase,
  tenantId: string,
  params: CompleteRunParams,
  tx?: PostgresJsDatabase,
): Promise<boolean> {
  const exec = async (handle: PostgresJsDatabase): Promise<boolean> => {
    const updated = await handle
      .update(workflowRuns)
      .set({
        status: params.status,
        completedAt: params.completedAt,
        ...(params.totalCostCents != null ? { totalCostCents: params.totalCostCents } : {}),
        ...(params.totalTokens != null ? { totalTokens: params.totalTokens } : {}),
        ...(params.failureJson != null ? { failureJson: params.failureJson } : {}),
        ...(params.learningsJson != null ? { learningsJson: params.learningsJson } : {}),
        ...(params.status === 'cancelled' && params.cancellation
          ? {
              cancelledBy: params.cancellation.cancelledBy,
              ...(params.cancellation.reason !== undefined
                ? { cancelReason: params.cancellation.reason }
                : {}),
            }
          : {}),
      })
      .where(
        and(
          eq(workflowRuns.runId, params.runId),
          // CAS guard: only transition non-terminal runs. Mirrors
          // isTerminalRunStatus() in WorkflowRunHarness.
          sql`${workflowRuns.status} NOT IN ('completed', 'failed', 'cancelled')`,
        ),
      )
      .returning({ runId: workflowRuns.runId });
    return updated.length > 0;
  };
  if (tx) {
    return exec(tx);
  }
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, exec);
}

export interface UpdateRunMetadataParams {
  runId: string;
  learningsJson?: unknown;
  totalCostCents?: number;
  totalTokens?: number;
  failureJson?: unknown;
  score?: number;
  scoreProvenance?: unknown;
}

/**
 * Patch metadata on a run without changing its status or completedAt.
 * Use this for learnings and cost aggregates on runs that may still be
 * active. Evaluation state is NOT patchable here — `evaluation_json` has a
 * single writer, `writeRunEvaluationEnvelope`.
 */
export async function updateRunMetadata(
  db: PostgresJsDatabase,
  tenantId: string,
  params: UpdateRunMetadataParams,
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  const setClause: Record<string, unknown> = {};
  if (params.learningsJson != null) setClause['learningsJson'] = params.learningsJson;
  if (params.totalCostCents != null) setClause['totalCostCents'] = params.totalCostCents;
  if (params.totalTokens != null) setClause['totalTokens'] = params.totalTokens;
  if (params.failureJson != null) setClause['failureJson'] = params.failureJson;
  if (params.score !== undefined) setClause['score'] = params.score;
  if (params.scoreProvenance !== undefined) setClause['scoreProvenance'] = params.scoreProvenance;

  if (Object.keys(setClause).length === 0) return;

  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx.update(workflowRuns).set(setClause).where(eq(workflowRuns.runId, params.runId));
  });
}

/** Update the session owner of a run (used when adopting an orphaned run). */
export async function updateRunSessionId(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  sessionId: string,
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx.update(workflowRuns).set({ sessionId }).where(eq(workflowRuns.runId, runId));
  });
}

/** Resume a paused or failed run — set status back to running. */
export async function resumeRun(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .update(workflowRuns)
      .set({
        status: 'running',
        completedAt: null,
      })
      .where(
        and(eq(workflowRuns.runId, runId), inArray(workflowRuns.status, ['paused', 'failed'])),
      );
  });
}

/**
 * Recover a stalled running run — reset the scheduler cursor so the next
 * scheduling pass treats it as fresh. For runs that are already 'running'
 * but whose scheduler cursor has expired (orphaned/stalled).
 *
 * 104d Phase 0: this is the write-side complement to deriveRunLiveness()
 * detecting 'stalled'. Without this, the resume handler would accept a
 * stalled run but leave it in the same stalled state.
 */
export async function recoverStalledRun(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  sessionId: string,
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .update(workflowRuns)
      .set({
        schedulerCursorAt: new Date(),
        sessionId,
      })
      .where(and(eq(workflowRuns.runId, runId), eq(workflowRuns.status, 'running')));
  });
}

/**
 * Update the scheduler cursor on a run (104d Phase 1).
 * Called on every scheduling pass so liveness derivation can detect stalled runs.
 */
export async function updateSchedulerCursor(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, async (tx) => {
    await tx
      .update(workflowRuns)
      .set({ schedulerCursorAt: new Date() })
      .where(eq(workflowRuns.runId, runId));
  });
}

export interface PauseRunOptions {
  /** Typed pause cause — see WorkflowRunPauseReason in @aflow/schemas. */
  reason?: string | null;
  /** PayloadStore ref to the structured WorkflowResumeContract. */
  payloadRef?: string | null;
  /**
   * What execution observed, supplied by the caller that BUILT the contract —
   * the only place that can still tell a subject's answer from the placeholder
   * the harness writes when there was none.
   */
  executionState?: TrialExecutionState | undefined;
}

export async function pauseRun(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  opts: PauseRunOptions = {},
  tx?: PostgresJsDatabase,
): Promise<void> {
  const exec = async (handle: PostgresJsDatabase): Promise<void> => {
    await handle
      .update(workflowRuns)
      .set({
        status: 'paused',
        pauseVersion: sql`${workflowRuns.pauseVersion} + 1`,
        // Defensively clear any stale resume claim from a prior pause
        // cycle. A new resume will acquire a fresh claim against the
        // bumped pause_version.
        resumeClaimToken: null,
        resumeClaimExpiresAt: null,
        resumeAttemptCount: 0,
        ...(opts.reason !== undefined ? { pausedReason: opts.reason } : {}),
        ...(opts.payloadRef !== undefined ? { pausedPayloadRef: opts.payloadRef } : {}),
        ...(opts.executionState !== undefined ? { executionState: opts.executionState } : {}),
      })
      .where(
        and(eq(workflowRuns.runId, runId), inArray(workflowRuns.status, ['running', 'paused'])),
      );
  };
  if (tx) {
    await exec(tx);
    return;
  }
  const tenantCtx = createTenantContext(tenantId as TenantId);
  await withTenantSchema(db, tenantCtx, exec);
}

export interface PauseRunningRunByOperatorOptions {
  /** Typed pause cause stored on `workflow_runs.paused_reason` (e.g. 'manual'). */
  reason: string;
  /** PayloadStore ref of the stored `WorkflowResumeContract`. */
  payloadRef: string;
  executionState?: TrialExecutionState | undefined;
}

export type PauseRunningRunByOperatorResult =
  { paused: true; pauseVersion: number } | { paused: false };

export async function pauseRunningRunByOperator(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  opts: PauseRunningRunByOperatorOptions,
  tx?: PostgresJsDatabase,
): Promise<PauseRunningRunByOperatorResult> {
  const exec = async (handle: PostgresJsDatabase): Promise<PauseRunningRunByOperatorResult> => {
    const updated = await handle
      .update(workflowRuns)
      .set({
        status: 'paused',
        pauseVersion: sql`${workflowRuns.pauseVersion} + 1`,
        resumeClaimToken: null,
        resumeClaimExpiresAt: null,
        resumeAttemptCount: 0,
        pausedReason: opts.reason,
        pausedPayloadRef: opts.payloadRef,
        ...(opts.executionState !== undefined ? { executionState: opts.executionState } : {}),
      })
      .where(and(eq(workflowRuns.runId, runId), eq(workflowRuns.status, 'running')))
      .returning({ pauseVersion: workflowRuns.pauseVersion });
    const row = updated[0];
    if (!row) return { paused: false };
    return { paused: true, pauseVersion: row.pauseVersion };
  };
  if (tx) {
    return exec(tx);
  }
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, exec);
}

export interface RepausePausedRunAtVersionOptions {
  reason?: string | null;
  payloadRef?: string | null;
  expectedPauseVersion: number;
  resumeClaimToken?: string;
  executionState?: TrialExecutionState | undefined;
}

/**
 * Re-pause an already-paused run at a known `pause_version` (CAS). Unlike
 * {@link pauseRun}, this never transitions `running` → `paused`, so a stale
 * cap-promotion path cannot re-pause a run that already resumed.
 */
export async function repausePausedRunAtVersion(
  db: PostgresJsDatabase,
  tenantId: string,
  runId: string,
  opts: RepausePausedRunAtVersionOptions,
  tx?: PostgresJsDatabase,
): Promise<boolean> {
  const exec = async (handle: PostgresJsDatabase): Promise<boolean> => {
    const conditions = [
      eq(workflowRuns.runId, runId),
      eq(workflowRuns.status, 'paused'),
      eq(workflowRuns.pauseVersion, opts.expectedPauseVersion),
    ];
    if (opts.resumeClaimToken !== undefined) {
      conditions.push(eq(workflowRuns.resumeClaimToken, opts.resumeClaimToken));
    }
    const updated = await handle
      .update(workflowRuns)
      .set({
        status: 'paused',
        pauseVersion: sql`${workflowRuns.pauseVersion} + 1`,
        resumeClaimToken: null,
        resumeClaimExpiresAt: null,
        resumeAttemptCount: 0,
        ...(opts.reason !== undefined ? { pausedReason: opts.reason } : {}),
        ...(opts.payloadRef !== undefined ? { pausedPayloadRef: opts.payloadRef } : {}),
        ...(opts.executionState !== undefined ? { executionState: opts.executionState } : {}),
      })
      .where(and(...conditions))
      .returning({ runId: workflowRuns.runId });
    return updated.length === 1;
  };
  if (tx) {
    return exec(tx);
  }
  const tenantCtx = createTenantContext(tenantId as TenantId);
  return withTenantSchema(db, tenantCtx, exec);
}
