/**
 * Eval-batch store (Plan 269 D17): the durable rows ARE the state machine.
 * Batch heads CAS on `status`; trials are idempotent per
 * `(batchId, caseRevisionId, trial)` and move disposition-wise
 * (scheduled/infra_retry → running → graded | cancelled | never_started)
 * under a lease. Live contention is arbitrated a level up, by the engine's
 * per-tenant due claim, so these leases exist to survive worker death.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type {
  EvalBatchProvenanceManifest,
  EvalBatchStatus,
  EvalBatchSummary,
  EvalCaseResultDisposition,
  EvalCaseTrialResults,
  EvalCaseTrialVerdict,
  TrialOutcome,
  GoldenCaseRevision,
  TenantId,
} from '@aflow/schemas';
import {
  createTenantContext,
  evalBaselines,
  evalBatches,
  evalBatchMembers,
  evalCaseResults,
  goldenCaseRevisions,
  simulationCallRecords,
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
  type EvalBaselineRow,
  type EvalBatchRow,
  type EvalCaseResultRow,
  type WorkflowRunRow,
  type WorkflowRunTaskRow,
} from '@aflow/database';
import { tryRowToCaseRevision } from './goldenDatasetStore.js';

const CLAIMABLE_DISPOSITIONS: readonly EvalCaseResultDisposition[] = ['scheduled', 'infra_retry'];

// ============================================================================
// Creation (launch-time freeze)
// ============================================================================

export interface CreateEvalBatchParams {
  spaceId: string;
  workflowSlug: string;
  datasetId: string;
  datasetVersion: number;
  workflowRevision: number;
  trialsPerCase: number;
  maxConcurrentTrials: number;
  costCeilingCents: number;
  /** D10: graded trials drawn uniformly into the validation label queue at completion. */
  validationSliceSize: number;
  provenanceManifest: EvalBatchProvenanceManifest;
  notes?: string | undefined;
  caseRevisionIds: readonly string[];
  createdByUserId?: string | undefined;
}

/**
 * Persist the batch atomically: head (status 'queued'), the frozen
 * membership, and one 'scheduled' trial row per (caseRevision × trial).
 * After commit the durable engine owns everything.
 */
export async function createEvalBatch(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: CreateEvalBatchParams,
): Promise<{ batchId: string }> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const [batchRow] = await tx
      .insert(evalBatches)
      .values({
        spaceId: params.spaceId,
        workflowSlug: params.workflowSlug,
        datasetId: params.datasetId,
        datasetVersion: params.datasetVersion,
        workflowRevision: params.workflowRevision,
        status: 'queued',
        trialsPerCase: params.trialsPerCase,
        maxConcurrentTrials: params.maxConcurrentTrials,
        costCeilingCents: params.costCeilingCents,
        validationSliceSize: params.validationSliceSize,
        provenanceManifestJson: params.provenanceManifest,
        notes: params.notes ?? null,
        createdByUserId: params.createdByUserId ?? null,
      })
      .returning({ id: evalBatches.id });
    const batchId = batchRow!.id;

    await tx
      .insert(evalBatchMembers)
      .values(params.caseRevisionIds.map((caseRevisionId) => ({ batchId, caseRevisionId })));

    const trialRows = params.caseRevisionIds.flatMap((caseRevisionId) =>
      Array.from({ length: params.trialsPerCase }, (_, i) => ({
        batchId,
        caseRevisionId,
        trial: i + 1,
        disposition: 'scheduled' as const,
      })),
    );
    await tx.insert(evalCaseResults).values(trialRows).onConflictDoNothing();

    return { batchId };
  });
}

// ============================================================================
// Reads
// ============================================================================

export async function getEvalBatchHead(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; batchId: string },
): Promise<EvalBatchRow | null> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const [row] = await tx
      .select()
      .from(evalBatches)
      .where(and(eq(evalBatches.id, params.batchId), eq(evalBatches.spaceId, params.spaceId)))
      .limit(1);
    return row ?? null;
  });
}

/** Engine-internal read — batchId is the tenant-scoped primary key. */
export async function getEvalBatchById(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  batchId: string,
): Promise<EvalBatchRow | null> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const [row] = await tx.select().from(evalBatches).where(eq(evalBatches.id, batchId)).limit(1);
    return row ?? null;
  });
}

export async function listEvalBatches(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; workflowSlug?: string | undefined; limit: number },
): Promise<EvalBatchRow[]> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select()
      .from(evalBatches)
      .where(
        and(
          eq(evalBatches.spaceId, params.spaceId),
          ...(params.workflowSlug !== undefined
            ? [eq(evalBatches.workflowSlug, params.workflowSlug)]
            : []),
        ),
      )
      .orderBy(desc(evalBatches.createdAt))
      .limit(params.limit),
  );
}

/** Batches the durable engine still owes work: queued, running, cancelling. */
export async function listEvalBatchesNeedingWork(
  db: PostgresJsDatabase,
  tenantId: TenantId,
): Promise<EvalBatchRow[]> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select()
      .from(evalBatches)
      .where(inArray(evalBatches.status, ['queued', 'running', 'cancelling']))
      .orderBy(evalBatches.createdAt),
  );
}

/**
 * One trial row by its unique identity. The attribution view is a single-trial
 * read by design, so it asks for one row rather than paging the batch and
 * filtering in memory — otherwise its cost grows with cases × trials and every
 * drawer open gets slower as a batch gets larger.
 */
export async function getTrialRow(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { batchId: string; caseRevisionId: string; trial: number },
): Promise<EvalCaseResultRow | null> {
  const tenantCtx = createTenantContext(tenantId);
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select()
      .from(evalCaseResults)
      .where(
        and(
          eq(evalCaseResults.batchId, params.batchId),
          eq(evalCaseResults.caseRevisionId, params.caseRevisionId),
          eq(evalCaseResults.trial, params.trial),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function listTrialRows(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  batchId: string,
): Promise<EvalCaseResultRow[]> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select()
      .from(evalCaseResults)
      .where(eq(evalCaseResults.batchId, batchId))
      .orderBy(evalCaseResults.caseRevisionId, evalCaseResults.trial),
  );
}

/** The frozen membership a batch launched with (D12 pairing input). */
export async function listEvalBatchMemberRevisionIds(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  batchId: string,
): Promise<string[]> {
  const tenantCtx = createTenantContext(tenantId);
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({ caseRevisionId: evalBatchMembers.caseRevisionId })
      .from(evalBatchMembers)
      .where(eq(evalBatchMembers.batchId, batchId))
      .orderBy(evalBatchMembers.caseRevisionId),
  );
  return rows.map((r) => r.caseRevisionId);
}

export async function getGoldenCaseRevisionsByIds(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  revisionIds: readonly string[],
): Promise<Map<string, GoldenCaseRevision>> {
  if (revisionIds.length === 0) return new Map();
  const tenantCtx = createTenantContext(tenantId);
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select()
      .from(goldenCaseRevisions)
      .where(inArray(goldenCaseRevisions.id, [...revisionIds])),
  );
  // Tolerant like the dataset read, and for the same reason: this loader feeds
  // the batch detail and trial views, so one unreadable revision parsed inside
  // a map would 500 the surface an operator opens to find out what is wrong
  // with it. An absent revision is a shape every caller already handles.
  const revisions = new Map<string, GoldenCaseRevision>();
  for (const row of rows) {
    const parsed = tryRowToCaseRevision(row);
    if (parsed.ok) revisions.set(row.id, parsed.revision);
  }
  return revisions;
}

/**
 * Recent per-run cost history for the cost preflight — production runs only
 * (frozen trials are excluded so batches never feed their own estimate).
 */
export async function listRecentRunCostsForWorkflow(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; workflowSlug: string; limit: number },
): Promise<number[]> {
  const tenantCtx = createTenantContext(tenantId);
  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({ totalCostCents: workflowRuns.totalCostCents })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.spaceId, params.spaceId),
          eq(workflowRuns.workflowSlug, params.workflowSlug),
          sql`${workflowRuns.evalBatchId} IS NULL`,
          inArray(workflowRuns.status, ['completed', 'failed']),
          isNotNull(workflowRuns.totalCostCents),
        ),
      )
      .orderBy(desc(workflowRuns.startedAt))
      .limit(params.limit),
  );
  return rows
    .map((r) => r.totalCostCents)
    .filter((c): c is number => typeof c === 'number' && c >= 0);
}

/**
 * Runs the launcher already created for one (batch, caseRevision, trial) —
 * the reconcile source of truth for D17 idempotent dispatch. A crash
 * between run creation and `recordTrialRunId` leaves the trial row with a
 * NULL runId while the run keeps executing; the launcher stamps
 * `metadata.evalTrial` exactly so this lookup can adopt the survivor
 * instead of double-launching.
 */
export async function listRunsForEvalTrial(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { evalBatchId: string; caseRevisionId: string; trial: number },
): Promise<Array<{ runId: string; status: string }>> {
  const tenantCtx = createTenantContext(tenantId);
  const marker = JSON.stringify({
    evalTrial: { caseRevisionId: params.caseRevisionId, trial: params.trial },
  });
  return withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({ runId: workflowRuns.runId, status: workflowRuns.status })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.evalBatchId, params.evalBatchId),
          sql`${workflowRuns.metadata} @> ${marker}::jsonb`,
        ),
      )
      .orderBy(workflowRuns.startedAt, workflowRuns.runId),
  );
}

export interface TrialRunSnapshot {
  run: WorkflowRunRow;
  tasks: WorkflowRunTaskRow[];
  /**
   * Every simulated call the run journalled, oldest first. Loaded here rather
   * than derived at grading because the grader is a pure function: it decides
   * from a snapshot and reaches no database.
   */
  simulationCalls: SimulationCallRow[];
}

/** The journal columns a `simulation` expectation decides from. */
export interface SimulationCallRow {
  simulationId: string;
  endpointId: string;
  responseStatus: number;
  responseRef: string | null;
  deltaRef: string | null;
  ordinal: number;
}

export async function loadTrialRunSnapshot(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  runId: string,
): Promise<TrialRunSnapshot | null> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const [run] = await tx
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .limit(1);
    if (!run) return null;
    const tasks = await tx
      .select()
      .from(workflowRunTasks)
      .where(eq(workflowRunTasks.runId, runId))
      .orderBy(workflowRunTasks.taskId);
    // The journal is keyed on the session that MADE the calls, which for an
    // agent task is the worker session the harness spawned — not the workflow
    // run that owns it. Querying by runId alone returns nothing for exactly the
    // subject this instrument exists for, and an empty journal is
    // indistinguishable from a run that touched nothing: every `expect: 'none'`
    // then passes on no evidence.
    const callScopes = [run.sessionId, ...tasks.map((task) => task.workerSessionId), runId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    const simulationCalls = await tx
      .select({
        simulationId: simulationCallRecords.simulationId,
        endpointId: simulationCallRecords.endpointId,
        responseStatus: simulationCallRecords.responseStatus,
        responseRef: simulationCallRecords.responseRef,
        deltaRef: simulationCallRecords.deltaRef,
        ordinal: simulationCallRecords.ordinal,
      })
      .from(simulationCallRecords)
      .where(inArray(simulationCallRecords.runId, callScopes))
      // NOT `ordinal`: it counts calls per endpoint, so the first call to two
      // different endpoints both sort as 0 and the trajectory reports a
      // sequence the agent never took. The world version is monotonic across
      // the simulation's whole journal by construction, which makes it the
      // canonical replay order.
      .orderBy(simulationCallRecords.worldVersionAfter);
    return { run, tasks, simulationCalls };
  });
}

// ============================================================================
// Baseline pin (D12) — operator authority enforced at the route boundary
// ============================================================================

export async function getEvalBaseline(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; workflowSlug: string },
): Promise<EvalBaselineRow | null> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const [row] = await tx
      .select()
      .from(evalBaselines)
      .where(
        and(
          eq(evalBaselines.spaceId, params.spaceId),
          eq(evalBaselines.workflowSlug, params.workflowSlug),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/** Pin/repin upserts on (space, workflow) — idempotent by construction. */
export async function pinEvalBaseline(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: {
    spaceId: string;
    workflowSlug: string;
    batchId: string;
    pinnedByUserId?: string | undefined;
  },
): Promise<EvalBaselineRow> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const [row] = await tx
      .insert(evalBaselines)
      .values({
        spaceId: params.spaceId,
        workflowSlug: params.workflowSlug,
        batchId: params.batchId,
        pinnedAt: new Date(),
        pinnedByUserId: params.pinnedByUserId ?? null,
      })
      .onConflictDoUpdate({
        target: [evalBaselines.spaceId, evalBaselines.workflowSlug],
        set: {
          batchId: params.batchId,
          pinnedAt: new Date(),
          pinnedByUserId: params.pinnedByUserId ?? null,
        },
      })
      .returning();
    return row!;
  });
}

/** Idempotent: unpinning an unpinned skill is a no-op reporting `false`. */
export async function unpinEvalBaseline(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; workflowSlug: string },
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const deleted = await tx
      .delete(evalBaselines)
      .where(
        and(
          eq(evalBaselines.spaceId, params.spaceId),
          eq(evalBaselines.workflowSlug, params.workflowSlug),
        ),
      )
      .returning({ id: evalBaselines.id });
    return deleted.length > 0;
  });
}

// ============================================================================
// Batch head transitions
// ============================================================================

export async function casEvalBatchStatus(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { batchId: string; from: readonly EvalBatchStatus[]; to: EvalBatchStatus },
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(evalBatches)
      .set({
        status: params.to,
        updatedAt: new Date(),
        ...(params.to === 'running' ? { startedAt: new Date() } : {}),
      })
      .where(and(eq(evalBatches.id, params.batchId), inArray(evalBatches.status, [...params.from])))
      .returning({ id: evalBatches.id });
    return updated.length > 0;
  });
}

/** Operator-plane cancellation entry: stops claims; the worker drains. */
export async function requestEvalBatchCancel(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { spaceId: string; batchId: string },
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(evalBatches)
      .set({ status: 'cancelling', updatedAt: new Date() })
      .where(
        and(
          eq(evalBatches.id, params.batchId),
          eq(evalBatches.spaceId, params.spaceId),
          inArray(evalBatches.status, ['queued', 'running']),
        ),
      )
      .returning({ id: evalBatches.id });
    return updated.length > 0;
  });
}

/** Accumulate spend; returns the new total so the caller can check the ceiling. */
/**
 * A trial run's spend, summed from the per-step usage the executors record in
 * the durable event log.
 *
 * `workflow_runs.total_cost_cents` is deliberately NOT the source: the
 * per-step usage envelope is where cost is actually written, and the roll-up
 * onto the run/session row is not populated — reading the roll-up made the
 * batch ceiling unenforceable while reporting 0¢ as though trials were free.
 *
 * Sub-cent spend rounds UP: a ceiling that under-reports is worse than one
 * that trips slightly early, and a per-trial floor would erase a run of
 * cheap-but-not-free trials entirely.
 */
export async function sumTrialRunUsage(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  runId: string,
): Promise<{ costCents: number; totalTokens: number; usageSteps: number }> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    // `envelope->'usage' IS NOT NULL` rather than the `?` key-exists operator:
    // `?` is also the driver's bind placeholder, so the operator form breaks
    // the moment this query carries a parameter.
    const rows = (await tx.execute(
      sql`SELECT COALESCE(SUM((envelope->'usage'->>'totalCostUsd')::numeric), 0) AS usd,
                 COALESCE(SUM((envelope->'usage'->>'totalTokens')::bigint), 0) AS tokens,
                 COUNT(*) AS steps
            FROM event_log
           WHERE envelope->'usage' IS NOT NULL
             AND session_id::text IN (
                   SELECT worker_session_id::text FROM workflow_run_tasks
                    WHERE run_id = ${runId} AND worker_session_id IS NOT NULL
                   UNION
                   SELECT session_id::text FROM workflow_run_tasks
                    WHERE run_id = ${runId} AND session_id IS NOT NULL
                 )`,
    )) as unknown as Array<{ usd: string | null; tokens: string | null; steps: string | null }>;
    const row = rows[0];
    const usd = Number(row?.usd ?? 0);
    return {
      costCents: Number.isFinite(usd) ? Math.ceil(usd * 100) : 0,
      totalTokens: Number(row?.tokens ?? 0),
      usageSteps: Number(row?.steps ?? 0),
    };
  });
}

export async function addEvalBatchCost(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { batchId: string; deltaCents: number },
): Promise<number> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const [row] = await tx
      .update(evalBatches)
      .set({
        costSpentCents: sql`${evalBatches.costSpentCents} + ${params.deltaCents}`,
        updatedAt: new Date(),
      })
      .where(eq(evalBatches.id, params.batchId))
      .returning({ costSpentCents: evalBatches.costSpentCents });
    return row?.costSpentCents ?? 0;
  });
}

export async function terminalizeEvalBatch(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: {
    batchId: string;
    finalStatus: 'completed' | 'failed' | 'cancelled';
    summary: EvalBatchSummary;
  },
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(evalBatches)
      .set({
        status: params.finalStatus,
        summaryJson: params.summary,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(evalBatches.id, params.batchId),
          inArray(evalBatches.status, ['running', 'cancelling']),
        ),
      )
      .returning({ id: evalBatches.id });
    return updated.length > 0;
  });
}

// ============================================================================
// Trial transitions
// ============================================================================

export async function claimScheduledTrials(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { batchId: string; limit: number; leaseOwner: string; leaseExpiresAt: Date },
): Promise<EvalCaseResultRow[]> {
  if (params.limit <= 0) return [];
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const candidates = await tx
      .select({ id: evalCaseResults.id })
      .from(evalCaseResults)
      .where(
        and(
          eq(evalCaseResults.batchId, params.batchId),
          inArray(evalCaseResults.disposition, [...CLAIMABLE_DISPOSITIONS]),
        ),
      )
      .orderBy(evalCaseResults.caseRevisionId, evalCaseResults.trial)
      .limit(params.limit);
    if (candidates.length === 0) return [];
    return tx
      .update(evalCaseResults)
      .set({
        disposition: 'running',
        leaseOwner: params.leaseOwner,
        leaseExpiresAt: params.leaseExpiresAt,
        attempt: sql`${evalCaseResults.attempt} + 1`,
        startedAt: new Date(),
      })
      .where(
        and(
          inArray(
            evalCaseResults.id,
            candidates.map((c) => c.id),
          ),
          inArray(evalCaseResults.disposition, [...CLAIMABLE_DISPOSITIONS]),
        ),
      )
      .returning();
  });
}

/**
 * Adopt in-flight trials whose lease expired (worker died mid-trial). The
 * row keeps its runId — the adopter tracks the surviving run instead of
 * double-dispatching it.
 */
export async function adoptExpiredTrialLeases(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { batchId: string; leaseOwner: string; leaseExpiresAt: Date; now: Date },
): Promise<EvalCaseResultRow[]> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .update(evalCaseResults)
      .set({ leaseOwner: params.leaseOwner, leaseExpiresAt: params.leaseExpiresAt })
      .where(
        and(
          eq(evalCaseResults.batchId, params.batchId),
          eq(evalCaseResults.disposition, 'running'),
          lt(evalCaseResults.leaseExpiresAt, params.now),
        ),
      )
      .returning(),
  );
}

export async function renewTrialLeases(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { trialIds: readonly string[]; leaseOwner: string; leaseExpiresAt: Date },
): Promise<void> {
  if (params.trialIds.length === 0) return;
  const tenantCtx = createTenantContext(tenantId);
  await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .update(evalCaseResults)
      .set({ leaseExpiresAt: params.leaseExpiresAt })
      .where(
        and(
          inArray(evalCaseResults.id, [...params.trialIds]),
          eq(evalCaseResults.leaseOwner, params.leaseOwner),
          eq(evalCaseResults.disposition, 'running'),
        ),
      ),
  );
}

export async function recordTrialRunId(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { trialId: string; runId: string },
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId);
  await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .update(evalCaseResults)
      .set({ runId: params.runId })
      .where(eq(evalCaseResults.id, params.trialId)),
  );
}

export async function completeTrialGraded(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: {
    trialId: string;
    verdict: EvalCaseTrialVerdict;
    /**
     * The stored fold (Plan 301 §5.1). Required so every terminal path states
     * which kind of thing happened — a NULL class sends readers back to
     * deriving their own from `verdict`, which is the divergence this replaces.
     */
    outcome: TrialOutcome;
    results: EvalCaseTrialResults;
    costCents?: number | undefined;
    completedAt: Date;
    durationMs?: number | undefined;
  },
): Promise<boolean> {
  const tenantCtx = createTenantContext(tenantId);
  return withTenantSchema(db, tenantCtx, async (tx) => {
    const updated = await tx
      .update(evalCaseResults)
      .set({
        disposition: 'graded',
        verdict: params.verdict,
        outcomeClass: params.outcome.outcomeClass,
        aggregationVersion: params.outcome.aggregationVersion,
        resultsJson: params.results,
        costCents: params.costCents ?? null,
        completedAt: params.completedAt,
        durationMs: params.durationMs ?? null,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(
        and(eq(evalCaseResults.id, params.trialId), eq(evalCaseResults.disposition, 'running')),
      )
      .returning({ id: evalCaseResults.id });
    return updated.length > 0;
  });
}

/**
 * Infra failure within budget: the failure is NOT a verdict on the case.
 * The stale runId is cleared — the ledger (`listRunsForEvalTrial`), not a
 * dangling pointer from a prior attempt, decides what the re-claimed row
 * adopts.
 */
export async function markTrialInfraRetry(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { trialId: string },
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId);
  await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .update(evalCaseResults)
      .set({ disposition: 'infra_retry', runId: null, leaseOwner: null, leaseExpiresAt: null })
      .where(
        and(eq(evalCaseResults.id, params.trialId), eq(evalCaseResults.disposition, 'running')),
      ),
  );
}

export async function markTrialCancelled(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { trialId: string; completedAt: Date },
): Promise<void> {
  const tenantCtx = createTenantContext(tenantId);
  await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .update(evalCaseResults)
      .set({
        disposition: 'cancelled',
        completedAt: params.completedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(
        and(eq(evalCaseResults.id, params.trialId), eq(evalCaseResults.disposition, 'running')),
      ),
  );
}

/** Type the rows a halted batch will never run (D17 terminalization). */
export async function markPendingTrialsNeverStarted(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  params: { batchId: string },
): Promise<number> {
  const tenantCtx = createTenantContext(tenantId);
  const updated = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .update(evalCaseResults)
      .set({ disposition: 'never_started' })
      .where(
        and(
          eq(evalCaseResults.batchId, params.batchId),
          inArray(evalCaseResults.disposition, [...CLAIMABLE_DISPOSITIONS]),
        ),
      )
      .returning({ id: evalCaseResults.id }),
  );
  return updated.length;
}
