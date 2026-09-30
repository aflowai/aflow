import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type {
  StoredParentInstructions,
  StoredParentTaskInputs,
  TaskTargetedInstructions,
  WorkflowHumanDecision,
  WorkflowRunDetailGraph,
  WorkflowRunDetailGraphTaskHint,
  WorkflowRunDetailOutput,
  WorkflowRunDetailTask,
  WorkflowRunGraphFidelity,
  WorkflowRunResult,
  WorkflowRunTaskStatus,
  WorkflowSuggestedAction,
  WorkflowTask,
  Workflow,
} from '@aflow/schemas';
import {
  inferTaskType,
  StoredParentInstructionsSchema,
  StoredParentTaskInputsSchema,
  WorkflowTaskPriorFailureSchema,
  workflowWhenView,
  type WorkflowTaskPriorFailure,
} from '@aflow/schemas';
import { resolveWorkflowForRunRevision, readSessionUsage } from '@aflow/database';
import type { SessionUsage } from '@aflow/database';
import type { SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { loadRunById, type WorkflowTaskRow } from './ledger.js';
import { loadPendingWaiters } from './ledger.js';
import { resolveUserLabels } from './userLabels.js';
import { surfaceWorkflowResumeContract } from './workflowResume.js';
import {
  buildHumanTaskHydrationFields,
  decodeTaskOutput,
  resolveActionPreview,
  runContextFromDetail,
} from './humanTaskHydration.js';
import { loadWorkflowHumanTaskHydration } from './workflowHumanTaskHydration.js';
import { buildWorkflowRunResult } from './runResult.js';

export const RETRY_FAILED_TASK_DEFAULT_MAX_ATTEMPTS = 3;

/** Inline refs longer than this are dropped in a compact run.detail projection. */
const COMPACT_INLINE_REF_MAX = 1500;

/**
 * Coerce-or-drop persisted `prior_failures` so one malformed entry can't 500
 * the whole run-detail response (the response is serialized through
 * `WorkflowTaskPriorFailureSchema`). Fill a missing `failedAt` (the dominant
 * defect — pre-fix producer-rerun entries lacked it) from the task's best
 * timestamp; `safeParse` strips non-DTO fields and drops anything unsalvageable.
 */
export function sanitizePriorFailures(
  raw: unknown,
  fallbackFailedAt: string,
): WorkflowTaskPriorFailure[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: WorkflowTaskPriorFailure[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const parsed = WorkflowTaskPriorFailureSchema.safeParse({
      failedAt: fallbackFailedAt,
      ...(entry as Record<string, unknown>),
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out.length > 0 ? out : undefined;
}

export type WorkflowDefinitionResolution =
  | {
      kind: 'resolved';
      /** taskId → WorkflowTask. Empty / partial maps are valid if the
       *  resolver returned a workflow whose tasks[] is empty/partial. */
      tasksById: Map<string, WorkflowTask>;
    }
  | { kind: 'unresolvable' };

/**
 * Build a `WorkflowRunDetailOutput` for the given run. Returns `null` if the
 * run does not exist in the named space (callers map this to 404).
 *
 * Idempotent + cheap: one workflow_runs read, one workflow_run_tasks read,
 * one workflow_run_waiters read, optional workflow-definition read, and
 * (for paused runs only) one payload-store retrieve for the resume contract.
 */
export async function buildWorkflowRunDetail(
  db: PostgresJsDatabase,
  payloadStore: PayloadStore,
  tenantId: string,
  spaceId: string,
  runId: string,
  opts: { compact?: boolean } = {},
): Promise<WorkflowRunDetailOutput | null> {
  const run = await loadRunById(db, tenantId, spaceId, runId);
  if (!run) return null;

  // Compact projection (off by default; the run.detail op turns it on for the
  // token-sensitive MCP/agent path). A large INLINE ref's base64 IS the payload —
  // the bulk of the response, and often duplicated across tasks — so drop it; gs://
  // pointers are tiny and stay fetchable, and small inline payloads stay too.
  const compact = opts.compact ?? false;
  const projectRef = (ref: string | null | undefined): string | undefined => {
    if (ref === null || ref === undefined) return undefined;
    return compact && ref.startsWith('inline:') && ref.length > COMPACT_INLINE_REF_MAX
      ? undefined
      : ref;
  };

  // Best-effort workflow-definition load for `label` + `workflowTitle`,
  const workflowTaskNameById = new Map<string, string>();
  let definitionResolution: WorkflowDefinitionResolution = { kind: 'unresolvable' };
  let workflowTitle: string | undefined;
  let workflowGraph: WorkflowRunDetailGraph | undefined;
  let graphFidelity: WorkflowRunGraphFidelity | undefined;
  let resolvedWorkflow: Workflow | null = null;
  try {
    const resolved = await resolveWorkflowForRunRevision(
      db,
      tenantId as TenantId,
      spaceId,
      run.workflowSlug,
      run.workflowRevision,
    );
    const def = resolved.workflow;
    resolvedWorkflow = def;
    workflowTitle = def.name;
    const tasksById = new Map<string, WorkflowTask>();
    for (const t of def.tasks) {
      if (t.taskId && t.name) workflowTaskNameById.set(t.taskId, t.name);
      if (t.taskId) tasksById.set(t.taskId, t);
    }
    // Resolver succeeded, even if the resulting task list is empty
    // or missing the failed row's id — that's genuine schema drift,
    // distinct from a resolver failure.
    definitionResolution = { kind: 'resolved', tasksById };
    const graphResult = extractWorkflowGraphHint(
      def.tasks,
      run.tasks.map((t) => t.taskId),
    );
    graphFidelity = graphResult.graphFidelity;
    workflowGraph = graphResult.workflowGraph;
  } catch {
    // Display-only path — never throws on a missing/legacy definition.
    // `definitionResolution` stays `unresolvable`; suggestedAction is
  }

  const waiters = await loadPendingWaiters(db, tenantId, run.runId);

  let surfacedContract: Awaited<ReturnType<typeof surfaceWorkflowResumeContract>> | null = null;
  if (run.status === 'paused') {
    surfacedContract = await surfaceWorkflowResumeContract(db, payloadStore, tenantId, run.runId);
  }

  const tasksById =
    definitionResolution.kind === 'resolved'
      ? definitionResolution.tasksById
      : new Map<string, WorkflowTask>();

  const runContextForPreviewResolution = run.tasks.some(
    (t) => t.status === 'paused' && tasksById.get(t.taskId)?.actionPreview,
  )
    ? await runContextFromDetail(run, payloadStore, db, tenantId)
    : null;

  const durableHydrationByTask = new Map<
    string,
    Awaited<ReturnType<typeof loadWorkflowHumanTaskHydration>>
  >();
  for (const t of run.tasks) {
    if (t.status !== 'paused') continue;
    const loaded = await loadWorkflowHumanTaskHydration(
      { db, payloadStore },
      tenantId as TenantId,
      {
        runId: run.runId,
        taskId: t.taskId,
        expectedAttempt: t.attempt,
        expectedPauseVersion: run.pauseVersion,
      },
    );
    durableHydrationByTask.set(t.taskId, loaded);
  }

  const humanDecisionByTask = new Map<string, WorkflowHumanDecision>();
  for (const t of run.tasks) {
    const taskDef = tasksById.get(t.taskId);
    if (
      !taskDef ||
      inferTaskType(taskDef) !== 'human' ||
      (taskDef.intent ?? 'collect') !== 'approve'
    )
      continue;
    if (t.status === 'succeeded' || t.status === 'completed' || t.status === 'skipped') {
      // `skipped` covers the `reject` mode: the approve row lands in `skipped`
      // with a persisted `{ decision: 'rejected', … }` output. A row skipped by
      // its own `when` (never reached the operator) has no such output, so the
      // decision-value gate below leaves it without a humanDecision.
      const decoded = await decodeTaskOutput(t.outputRef, payloadStore);
      const decision = decoded?.['decision'];
      if (decision === 'approved' || decision === 'rejected') {
        const decidedAt = decoded?.['decidedAt'];
        const decidedBy = decoded?.['decidedBy'];
        const comment = decoded?.['comment'];
        humanDecisionByTask.set(t.taskId, {
          decision,
          ...(typeof decidedAt === 'string' ? { decidedAt } : {}),
          ...(typeof decidedBy === 'string' ? { decidedBy } : {}),
          ...(typeof comment === 'string' ? { comment } : {}),
        });
      }
    } else if (t.status === 'failed') {
      // Genuine fail-mode rejection (`workflow.run.resume` mode `fail`) — no
      // output payload; the reject reason is the only durable detail.
      humanDecisionByTask.set(t.taskId, {
        decision: 'rejected',
        ...(t.failureReason ? { comment: t.failureReason } : {}),
      });
    }
  }

  // Resolve `decidedBy` user ids → display labels (the persisted value is a
  // UUID). One batched lookup for all approved rows; display-only, so a
  // failure leaves the raw ids in place rather than breaking the read.
  if (humanDecisionByTask.size > 0) {
    try {
      const labels = await resolveUserLabels(
        db,
        [...humanDecisionByTask.values()]
          .map((d) => d.decidedBy)
          .filter((id): id is string => typeof id === 'string'),
      );
      if (labels.size > 0) {
        for (const [taskId, decision] of humanDecisionByTask) {
          const label = decision.decidedBy ? labels.get(decision.decidedBy) : undefined;
          if (label) humanDecisionByTask.set(taskId, { ...decision, decidedBy: label });
        }
      }
    } catch {
      // Display-only — keep the raw ids on a lookup failure.
    }
  }

  const workerSessionIds = run.tasks
    .map((t) => t.workerSessionId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  let usageBySession = new Map<string, SessionUsage>();
  if (workerSessionIds.length > 0) {
    try {
      usageBySession = await readSessionUsage(db, tenantId, workerSessionIds);
    } catch {
      // Display-only — omit usage on a lookup failure.
    }
  }

  const tasks: WorkflowRunDetailTask[] = run.tasks.map((t) => {
    const suggestedAction = buildSuggestedActionForFailedTask(
      t,
      definitionResolution,
      run.runId,
      run.workflowSlug,
      run.metadata,
    );
    const taskDef = tasksById.get(t.taskId);
    const durable = durableHydrationByTask.get(t.taskId);
    let humanFields: ReturnType<typeof buildHumanTaskHydrationFields> | undefined;
    if (t.status === 'paused' && durable?.kind === 'hydrated') {
      const h = durable.hydration;
      humanFields = {
        humanIntent: h.humanIntent,
        ...(h.failureMode ? { failureMode: h.failureMode } : {}),
        pauseVersion: run.pauseVersion,
        ...(h.resolutionSchema ? { resolutionSchema: h.resolutionSchema } : {}),
        ...(h.actionPreview ? { actionPreview: h.actionPreview } : {}),
        ...(surfacedContract
          ? { resumeContract: surfacedContract.contract }
          : { resumeContract: h.resumeContract }),
      };
    } else if (t.status === 'paused' && taskDef) {
      const resolvedPreview =
        taskDef.actionPreview && runContextForPreviewResolution
          ? resolveActionPreview(taskDef.actionPreview, runContextForPreviewResolution).preview
          : undefined;
      humanFields = buildHumanTaskHydrationFields({
        task: taskDef,
        runPauseVersion: run.pauseVersion,
        ...(surfacedContract ? { resumeContract: surfacedContract.contract } : {}),
        ...(resolvedPreview ? { resolvedActionPreview: resolvedPreview } : {}),
      });
    }
    const sanitizedPriorFailures = sanitizePriorFailures(
      t.priorFailures,
      (t.failedAt ?? t.completedAt ?? t.startedAt)?.toISOString() ?? '1970-01-01T00:00:00.000Z',
    );
    // Dispatch family for the surface task-row icon. Authoritative when the
    // workflow definition resolves (`inferTaskType`); the `operationId`-based
    // fallback covers drift (definition lost the row). A human row records
    // no `operationId`, so the durable hydration / resolved-decision trace
    // is the only "this is human" signal when the definition is gone.
    const taskType = deriveSurfaceTaskType({
      taskDef,
      operationId: t.operationId ?? undefined,
      looksHuman:
        Boolean(humanFields) || durable?.kind === 'hydrated' || humanDecisionByTask.has(t.taskId),
    });
    // Carry `humanIntent` on every human row, not just paused ones (the
    // paused `humanFields` path already sets it). A resolved approve/collect
    // row keeps its intent so the surface picks the right icon. Approve rows
    // have a `humanDecision`; absent ⇒ collect.
    const humanIntentFallback: 'approve' | 'collect' | undefined =
      taskType === 'human' && !humanFields
        ? (taskDef?.intent ?? (humanDecisionByTask.has(t.taskId) ? 'approve' : 'collect'))
        : undefined;
    const errorRef =
      taskType === 'operation' && t.status === 'failed' && t.workerSessionId
        ? payloadStore.buildRef({
            tenantId: tenantId as TenantId,
            runId: run.runId as SessionId,
            stepExecutionId: t.workerSessionId as StepExecutionId,
            attempt: t.attempt,
            kind: 'error',
          })
        : undefined;
    const outRef = projectRef(t.outputRef);
    const inRef = projectRef(t.inputRef);
    return {
      taskId: t.taskId,
      label: workflowTaskNameById.get(t.taskId) ?? t.taskId,
      status: t.status as WorkflowRunTaskStatus,
      attempt: t.attempt,
      ...(t.workerSessionId ? { workerSessionId: t.workerSessionId } : {}),
      ...(t.operationId ? { operationId: t.operationId } : {}),
      ...(taskType ? { taskType } : {}),
      ...(t.workerSessionId && usageBySession.has(t.workerSessionId)
        ? {
            stepCount: usageBySession.get(t.workerSessionId)!.stepCount,
            totalTokens: usageBySession.get(t.workerSessionId)!.totalTokens,
          }
        : {}),
      ...(humanIntentFallback ? { humanIntent: humanIntentFallback } : {}),
      ...(t.summary ? { summary: t.summary } : {}),
      ...(outRef ? { outputRef: outRef } : {}),
      ...(inRef ? { inputRef: inRef } : {}),
      ...(errorRef ? { errorRef } : {}),
      ...(t.failureReason ? { failureReason: t.failureReason } : {}),
      ...(t.startedAt ? { startedAt: t.startedAt.toISOString() } : {}),
      ...(t.completedAt ? { completedAt: t.completedAt.toISOString() } : {}),
      ...(t.errorCode ? { errorCode: t.errorCode } : {}),
      ...(t.errorClassification ? { errorClassification: t.errorClassification } : {}),
      ...(t.errorRetryable !== null ? { errorRetryable: t.errorRetryable } : {}),
      ...(t.failedAt ? { failedAt: t.failedAt.toISOString() } : {}),
      ...(sanitizedPriorFailures ? { priorFailures: sanitizedPriorFailures } : {}),
      ...(suggestedAction ? { suggestedAction } : {}),
      ...(humanFields ?? {}),
      ...(humanDecisionByTask.has(t.taskId)
        ? { humanDecision: humanDecisionByTask.get(t.taskId) }
        : {}),
    };
  });

  // First-class run output: promoted state + summary on every read; the
  // full sections (score / outcome checks / artifact pointer) on terminal
  // runs only. Best-effort — a result failure never blocks the detail read.
  let runResult: WorkflowRunResult | undefined;
  try {
    const isTerminal =
      run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
    runResult = await buildWorkflowRunResult(
      { db, payloadStore },
      {
        tenantId,
        run,
        workflow: resolvedWorkflow,
        scope: isTerminal ? 'full' : 'partial',
      },
    );
  } catch {
    // Omit `result` — the detail DTO remains valid without it.
  }

  const output: WorkflowRunDetailOutput = {
    run: {
      runId: run.runId,
      workflowSlug: run.workflowSlug,
      ...(workflowTitle ? { workflowTitle } : {}),
      workflowRevision: run.workflowRevision,
      status: run.status as WorkflowRunDetailOutput['run']['status'],
      pauseVersion: run.pauseVersion,
      ...(run.pausedReason ? { pausedReason: run.pausedReason } : {}),
      ...(run.cancelledBy
        ? { cancelledBy: run.cancelledBy as WorkflowRunDetailOutput['run']['cancelledBy'] }
        : {}),
      ...(run.cancelReason ? { cancelReason: run.cancelReason } : {}),
      startedAt: run.startedAt.toISOString(),
      ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
    },
    tasks,
    ...(graphFidelity ? { graphFidelity } : {}),
    ...(workflowGraph ? { workflowGraph } : {}),
    activeWaiters: waiters.map((w) => ({
      sessionId: w.waiterSessionId,
      ...(w.waiterStepExecutionId ? { stepExecutionId: w.waiterStepExecutionId } : {}),
      registeredAt: w.registeredAt.toISOString(),
    })),
    ...(runResult ? { result: runResult } : {}),
    ...(run.sessionId ? { originatingSessionId: run.sessionId } : {}),
  };

  // For paused runs, surface the live resume contract. `pauseVersion` is
  // freshly injected by `surfaceWorkflowResumeContract`, so the returned
  // `suggestedResumeCall` is actionable without a separate read.
  if (run.status === 'paused' && surfacedContract) {
    output.resumeContract = surfacedContract.contract;
  }

  return output;
}

/**
 * Derive the dispatch family (`agent` | `operation` | `human`) for a recorded
 * task row, for the surface task-row icon.
 *
 *   - Definition resolved → `inferTaskType(taskDef)` is authoritative.
 *   - Definition lost the row (drift) → infer from the denormalized
 *     `operationId`: agent tasks dispatch `ai.agent.turn`, operation tasks
 *     record their op id, and human tasks record no op — so `looksHuman`
 *     (any durable human-hydration / resolved-decision signal) is the only
 *     remaining "this is human" hint.
 *   - Nothing identifies it → `undefined` (the surface falls through to the
 *     generic icon).
 *
 * Pure + exported so the family logic can be pinned without a Postgres
 * fixture (mirrors `extractWorkflowGraphHint`).
 */
export function deriveSurfaceTaskType(args: {
  taskDef?: WorkflowTask | undefined;
  operationId?: string | undefined;
  looksHuman?: boolean | undefined;
}): 'agent' | 'operation' | 'human' | undefined {
  if (args.taskDef) return inferTaskType(args.taskDef);
  if (args.operationId === 'ai.agent.turn') return 'agent';
  if (args.operationId) return 'operation';
  if (args.looksHuman) return 'human';
  return undefined;
}

type GraphHintDefinitionTask = Pick<
  WorkflowTask,
  | 'taskId'
  | 'name'
  | 'dependsOn'
  | 'agent'
  | 'operation'
  | 'intent'
  | 'type'
  | 'pauseInstruction'
  | 'when'
>;

function graphTaskHintFromDefinition(
  task: GraphHintDefinitionTask,
): WorkflowRunDetailGraphTaskHint {
  const label = task.name || task.taskId;
  const when = task.when ? { when: workflowWhenView(task.when) } : {};
  try {
    const taskType = inferTaskType(task as WorkflowTask);
    return {
      taskId: task.taskId,
      label,
      taskType,
      ...(taskType === 'human' ? { humanIntent: task.intent ?? 'collect' } : {}),
      ...(taskType === 'operation' && task.operation ? { operationId: task.operation } : {}),
      ...(taskType === 'agent' ? { operationId: 'ai.agent.turn' } : {}),
      ...when,
    };
  } catch {
    return { taskId: task.taskId, label, ...when };
  }
}

export function extractWorkflowGraphHint(
  definitionTasks: readonly GraphHintDefinitionTask[],
  recordedTaskIds: readonly string[],
): { graphFidelity: WorkflowRunGraphFidelity; workflowGraph?: WorkflowRunDetailGraph } {
  const definitionIds = new Set<string>();
  for (const t of definitionTasks) {
    if (t.taskId) definitionIds.add(t.taskId);
  }
  const allRecordedCovered = recordedTaskIds.every((id) => definitionIds.has(id));
  if (!allRecordedCovered) {
    return { graphFidelity: 'degraded' };
  }
  const edges: Array<{ from: string; to: string }> = [];
  const taskHints: WorkflowRunDetailGraphTaskHint[] = [];
  for (const t of definitionTasks) {
    if (t.taskId) taskHints.push(graphTaskHintFromDefinition(t));
    if (!t.taskId || !t.dependsOn) continue;
    for (const from of t.dependsOn) {
      edges.push({ from, to: t.taskId });
    }
  }
  return {
    graphFidelity: 'full',
    workflowGraph: {
      taskIds: [...definitionIds],
      edges,
      taskHints,
    },
  };
}

export function buildSuggestedActionForFailedTask(
  task: WorkflowTaskRow,
  definitionResolution: WorkflowDefinitionResolution,
  runId: string,
  workflowSlug: string,
  runMetadata?: unknown,
): WorkflowSuggestedAction | undefined {
  if (task.status !== 'failed') return undefined;
  // P2 review fix — resolver failure ≠ definitively-broken workflow.
  // Omit the suggestion entirely; consumers see no recommendation and
  // fall back to their pre-Plan-149 behaviour (summarise failure +
  // ask the operator).
  if (definitionResolution.kind === 'unresolvable') return undefined;

  const taskDef = definitionResolution.tasksById.get(task.taskId);

  // Fresh-run buckets: the task def is gone from the resolved revision
  // (drift), or the row carries no (failedAt, attempt) CAS token the in-place
  // retry needs. Budget exhaustion is NOT here — a deliberate, root-cause-fixed
  // retry can still run in place (see below).
  const maxAttempts = taskDef?.maxAttempts ?? RETRY_FAILED_TASK_DEFAULT_MAX_ATTEMPTS;
  const missingCas = !task.failedAt;
  if (!taskDef || missingCas) {
    const reason = !taskDef
      ? `Task "${task.taskId}" is no longer in the current workflow definition — retry refuses across schema changes. Start a fresh run with the latest definition.`
      : `Task "${task.taskId}" failed without the (failedAt, attempt) CAS token the in-place retry mode requires (a harness-internal failure path that pre-dates this row). The only available next action is a fresh run.`;
    const instructions = extractInstructionsFromRunMetadata(runMetadata);
    const parentTaskInputs = extractParentTaskInputsFromRunMetadata(runMetadata);
    return {
      op: 'workflow.run.start',
      args: {
        slug: workflowSlug,
        wait: 'until_pause',
        concurrency: 'fail_if_active',
        acknowledgeOperatorCancel: false,
        ...(instructions !== undefined ? { instructions } : {}),
        ...(parentTaskInputs ? { inputs: parentTaskInputs.inputs } : {}),
      },
      preconditions: reason,
      upstreamStatePreserved: false,
    };
  }

  // In-place retry bucket. `task.failedAt` is non-null (the `missingCas` guard
  // above routes NULL-failedAt rows away); TS can't see across the boolean
  // check, so re-narrow with an explicit local.
  /* istanbul ignore next — narrow-only fallback (unreachable at runtime) */
  const failedAt: Date = task.failedAt ?? new Date(0);
  const budgetExhausted = task.attempt >= maxAttempts;
  const retryability = taskDef.retryability ?? 'unknown';
  const errorCodeMention = task.errorCode
    ? `Resolve ${task.errorCode}: fix the underlying API binding, credentials, or input data, then retry.`
    : 'Resolve the failure cause (API binding, credentials, or input data) before retrying.';
  let preconditions: string;
  if (task.errorRetryable === true) {
    preconditions = 'No external state needs fixing; the error was transient.';
  } else {
    preconditions = errorCodeMention;
  }
  if (retryability !== 'safe') {
    preconditions = `Side effects may have occurred; verify external state before retry. ${preconditions}`;
  }
  if (budgetExhausted) {
    preconditions =
      `Automatic retry budget spent (attempt=${String(task.attempt)} >= maxAttempts=${String(maxAttempts)}). ` +
      'After fixing the root cause, add `remediationConfirmed: true` to the resolution to retry in place ' +
      `(upstream work preserved) instead of starting a fresh run. ${preconditions}`;
  }

  // The suggested call omits `remediationConfirmed` even when exhausted, so a
  // verbatim copy can't rubber-stamp the budget bypass — Helmsman must add it
  // after confirming the root-cause fix.
  return {
    op: 'workflow.run.resume',
    args: {
      runId,
      resolution: {
        mode: 'retry_failed_task',
        taskId: task.taskId,
        failedAt: failedAt.toISOString(),
        attempt: task.attempt,
      },
      takeOver: false,
    },
    preconditions,
    upstreamStatePreserved: true,
  };
}

/**
 * Narrow `workflow_runs.metadata.parentInstructions` into a typed
 * `TaskTargetedInstructions` (the input shape `workflow.run.start`
 * accepts). Returns `undefined` on absent or malformed metadata.
 *
 * Same fail-soft discipline as `taskHelpers.extractParentInstructions`
 * in the orchestrator; duplicated here so this package doesn't depend
 * on the app layer.
 */
function extractInstructionsFromRunMetadata(
  runMetadata: unknown,
): TaskTargetedInstructions | undefined {
  if (!runMetadata || typeof runMetadata !== 'object') return undefined;
  const raw = (runMetadata as Record<string, unknown>)['parentInstructions'];
  if (raw === undefined) return undefined;
  const parsed = StoredParentInstructionsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const stored: StoredParentInstructions = parsed.data;
  // The stored shape is normalised; recover the wire-shape
  // `TaskTargetedInstructions` (either string or array).
  if ('runLevel' in stored) return stored.runLevel;
  return stored.taskTargeted;
}

/**
 * Narrow `workflow_runs.metadata.parentTaskInputs` into
 * `StoredParentTaskInputs` (or undefined / malformed). The caller
 * threads `.inputs` into `workflow.run.start.inputs`; the handler
 * validates them against the (possibly-changed) first task's input
 * contract. A mismatch surfaces as `PARENT_INPUTS_INVALID` — better
 * than dropping the operator's data silently.
 */
function extractParentTaskInputsFromRunMetadata(
  runMetadata: unknown,
): StoredParentTaskInputs | undefined {
  if (!runMetadata || typeof runMetadata !== 'object') return undefined;
  const raw = (runMetadata as Record<string, unknown>)['parentTaskInputs'];
  if (raw === undefined) return undefined;
  const parsed = StoredParentTaskInputsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data;
}
