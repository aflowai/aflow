/**
 * Routes a consumer's typed `producer-contract` failure by the consumer's
 * authored `onContractFailure`: `rerun` re-arms the blamed producer with the
 * error as `system_feedback`; `signal_blocked` and exhausted `maxProducerReruns`
 * pause the consumer; everything else returns `not_routed` for fail propagation.
 */
import { Buffer } from 'node:buffer';
import {
  buildResumeContract,
  casCompleteTask,
  commitProducerRerun,
  computeDescendants,
  countProducerReruns,
  storeWorkflowResumeContract,
  type ProducerRerunProvenance,
  type WorkflowRunDetail,
  type WorkflowTaskRow,
} from '@aflow/cybernetic-runtime';
import {
  ContractErrorSchema,
  type ContractError,
  type OnContractFailureRoute,
  type SessionId,
  type TenantId,
  type Workflow,
  type WorkflowTask,
} from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { bumpSchedulerCursorVersion, emitTaskUpdate } from './helpers.js';
import { applyFailureMode, pauseRunForTask } from './pauseResume.js';
import { dispatchRetriedTask } from './dispatchRetriedTask.js';
import type { HarnessDeps, WorkflowTaskOutcome } from './types.js';

/** Fallback when a `producer: 'rerun'` route omits `maxProducerReruns`. */
const DEFAULT_MAX_PRODUCER_RERUNS = 2;

/**
 * Producer-contract blame is the only producer-fixable class — its `source` is
 * always the `binding` shape, so `bindAs` / `producerTaskId` are present.
 */
type ProducerContractError = Extract<ContractError, { blame: 'producer-contract' }>;

function isProducerContract(e: ContractError): e is ProducerContractError {
  return e.blame === 'producer-contract';
}

export type ContractFailureRouteResult =
  /** A producer rerun was initiated (or subsumed by a concurrent one). Drop this result. */
  | { kind: 'reran' }
  /** Paused (signal_blocked escalation or retry_budget_exceeded). Drop this result. */
  | { kind: 'paused' }
  /** No producer-contract route applied — caller continues normal failed handling. */
  | { kind: 'not_routed' };

export interface TryRouteContractFailureArgs {
  tenantId: TenantId;
  run: WorkflowRunDetail;
  /** Resolved workflow definition (null when unresolvable → not_routed). */
  workflow: Workflow | null;
  /** The failed consumer task row (still `running` — not yet recorded failed). */
  consumerTaskRow: WorkflowTaskRow;
  attempt: number;
  outcome: Extract<WorkflowTaskOutcome, { kind: 'failed' }>;
}

export async function tryRouteContractFailure(
  deps: HarnessDeps,
  args: TryRouteContractFailureArgs,
): Promise<ContractFailureRouteResult> {
  const { tenantId, run, workflow, consumerTaskRow, attempt, outcome } = args;
  const consumerTaskId = consumerTaskRow.taskId;
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:contractFailureRoute',
    runId: run.runId,
    taskId: consumerTaskId,
    attempt,
  });

  if (!workflow || !outcome.errorRef) return { kind: 'not_routed' };
  const consumerTaskDef = workflow.tasks.find((t) => t.taskId === consumerTaskId);
  const onContractFailure = consumerTaskDef?.onContractFailure;
  if (!consumerTaskDef || !onContractFailure) return { kind: 'not_routed' };

  const contractErrors = await decodeContractErrors(deps, outcome.errorRef);
  // producer-output is already handled by the producer's own validate_output
  // pause; platform / consumer-binding are not producer-attributable.
  const producerContractErrors = contractErrors.filter(isProducerContract);
  if (producerContractErrors.length === 0) return { kind: 'not_routed' };

  const resolveRoute = (bindAs: string): OnContractFailureRoute | undefined =>
    onContractFailure.perBinding?.[bindAs] ?? onContractFailure.default;

  const rerunErrors = producerContractErrors.filter(
    (e) => resolveRoute(e.source.bindAs)?.producer === 'rerun',
  );
  const signalBlockedErrors = producerContractErrors.filter(
    (e) => resolveRoute(e.source.bindAs)?.producer === 'signal_blocked',
  );

  // Precedence: a rerun subsumes everything (regenerating the producer fixes
  // all its contract violations), then signal_blocked, then fall through.
  if (rerunErrors.length > 0) {
    return await routeProducerRerun(deps, {
      tenantId,
      run,
      workflow,
      consumerTaskId,
      consumerTaskRow,
      attempt,
      rerunErrors,
      resolveRoute,
      log,
    });
  }

  if (signalBlockedErrors.length > 0) {
    await pauseConsumerForContractEscalation(deps, {
      tenantId,
      run,
      consumerTaskDef,
      consumerTaskRow,
      attempt,
      errors: signalBlockedErrors,
    });
    return { kind: 'paused' };
  }

  return { kind: 'not_routed' };
}

async function routeProducerRerun(
  deps: HarnessDeps,
  args: {
    tenantId: TenantId;
    run: WorkflowRunDetail;
    workflow: Workflow;
    consumerTaskId: string;
    consumerTaskRow: WorkflowTaskRow;
    attempt: number;
    rerunErrors: ProducerContractError[];
    resolveRoute: (bindAs: string) => OnContractFailureRoute | undefined;
    log: ReturnType<ReturnType<typeof getOrchestratorLogger>['child']>;
  },
): Promise<ContractFailureRouteResult> {
  const { tenantId, run, workflow, consumerTaskId, consumerTaskRow, attempt, rerunErrors, log } =
    args;
  const tenantIdStr = tenantId as string;

  // Aggregate every same-producer error so the regenerated producer sees all
  // its violations at once.
  const producerTaskId = rerunErrors[0]!.source.producerTaskId;
  const bindAs = rerunErrors[0]!.source.bindAs;
  const route = args.resolveRoute(bindAs);
  const maxProducerReruns =
    typeof route?.maxProducerReruns === 'number'
      ? route.maxProducerReruns
      : DEFAULT_MAX_PRODUCER_RERUNS;
  const sameProducerErrors = rerunErrors.filter((e) => e.source.producerTaskId === producerTaskId);
  const feedback = aggregateProducerFeedback(sameProducerErrors);

  const producerRow = run.tasks.find((t) => t.taskId === producerTaskId);
  if (!producerRow) {
    log.warn(
      `[contractFailureRoute] rerun route blames producer="${producerTaskId}" with no task row; falling through to fail`,
    );
    return { kind: 'not_routed' };
  }
  if (producerRow.status !== 'succeeded') {
    // A concurrent sibling-validator failure already re-armed the producer.
    log.info(
      `[contractFailureRoute] producer="${producerTaskId}" status=${producerRow.status} (not succeeded); rerun already in flight — subsuming`,
    );
    return { kind: 'reran' };
  }

  const rerunsSpent = countProducerReruns(producerRow.priorFailures, {
    consumerTaskId,
    bindAs,
    producerTaskId,
  });
  if (rerunsSpent >= maxProducerReruns) {
    log.info(
      `[contractFailureRoute] producer rerun budget exhausted (spent=${String(rerunsSpent)} >= max=${String(maxProducerReruns)}) for consumer=${consumerTaskId} bindAs=${bindAs} producer=${producerTaskId}; pausing retry_budget_exceeded`,
    );
    await pauseConsumerRetryBudgetExceeded(deps, {
      tenantId,
      run,
      consumerTaskDef: workflow.tasks.find((t) => t.taskId === consumerTaskId)!,
      consumerTaskRow,
      attempt,
      producerTaskId,
      maxProducerReruns,
    });
    return { kind: 'paused' };
  }

  const provenance: ProducerRerunProvenance = {
    kind: 'producer_contract_rerun',
    failedAt: new Date().toISOString(),
    consumerTaskId,
    bindAs,
    producerTaskId,
    ...(feedback.contractName ? { contractName: feedback.contractName } : {}),
    attempt: producerRow.attempt,
    failureReason: `Consumer "${consumerTaskId}" rejected binding "${bindAs}": ${feedback.zodIssues
      .map((i) => i.message)
      .join('; ')}`.slice(0, 1000),
  };
  const descendantTaskIds = [...computeDescendants(workflow.tasks, new Set([producerTaskId]))];

  const commit = await commitProducerRerun(deps.db, tenantIdStr, {
    runId: run.runId,
    producerTaskId,
    expectedProducerAttempt: producerRow.attempt,
    descendantTaskIds,
    provenance,
  });
  if (commit.kind === 'at_parallel_limit') {
    // The producer row is untouched, so no rerun happened. Anything other than
    // `not_routed` would make the caller drop the consumer's failure for a
    // remediation that never started; normal failed handling surfaces it.
    log.info(
      `[contractFailureRoute] producer="${producerTaskId}" rerun refused: run at its parallel-task limit`,
    );
    return { kind: 'not_routed' };
  }
  if (commit.kind === 'producer_not_resettable') {
    log.info(
      `[contractFailureRoute] producer="${producerTaskId}" not resettable at commit (concurrent rerun won); subsuming`,
    );
    return { kind: 'reran' };
  }

  await bumpSchedulerCursorVersion(deps.db, tenantIdStr, run.runId);

  // The deleted descendant rows include the producer's sibling consumers,
  // which all depend only on the producer and so dispatched in parallel when
  // it first succeeded — any that already emitted `running` would otherwise
  // sit stuck "running" in live surfaces. Tell clients to drop them back to
  // forward-DAG queued, matching what a fresh BFF hydration shows.
  const labelByTaskId = new Map(workflow.tasks.map((t) => [t.taskId, t.name]));
  await Promise.all(
    commit.clearedTaskIds.map((clearedId) =>
      emitTaskUpdate(deps, {
        tenantId,
        runId: run.runId,
        taskId: clearedId,
        label: labelByTaskId.get(clearedId) ?? clearedId,
        status: 'scheduled',
        attempt: 1,
        cleared: true,
      }).catch((err: unknown) => {
        logOrchestratorError(
          `[contractFailureRoute] emit WorkflowTaskUpdate(cleared) failed for task=${clearedId}`,
          err,
          { runId: run.runId, taskId: clearedId },
        );
      }),
    ),
  );

  try {
    await dispatchRetriedTask(deps, {
      tenantId,
      runId: run.runId,
      taskId: producerTaskId,
      attempt: commit.newAttempt,
      helmsmanSessionId: (run.sessionId ?? '') as SessionId,
      systemFeedback: feedback,
    });
    log.info(
      `[contractFailureRoute] re-dispatched producer="${producerTaskId}" attempt=${String(commit.newAttempt)} with system_feedback (spent=${String(rerunsSpent + 1)}/${String(maxProducerReruns)})`,
    );
  } catch (err) {
    // A pre-claim throw leaves the re-armed producer `running` with no worker;
    // without this CAS, applyFailureMode would block descendants but never
    // terminate. The terminal-status guard no-ops if the post-claim path
    // (postClaimFailure) already marked the row failed.
    const reason = err instanceof Error ? err.message : String(err);
    logOrchestratorError(
      `[contractFailureRoute] producer rerun dispatch failed for run=${run.runId} producer=${producerTaskId}`,
      err,
      { runId: run.runId, producerTaskId },
    );
    try {
      await casCompleteTask(deps.db, tenantIdStr, {
        runId: run.runId,
        taskId: producerTaskId,
        attempt: commit.newAttempt,
        status: 'failed',
        completedAt: new Date(),
        failedAt: new Date(),
        failureReason: `Producer rerun dispatch failed: ${reason}`,
        errorCode: 'PRODUCER_RERUN_DISPATCH_FAILED',
        errorClassification: 'internal',
        errorRetryable: false,
      });
    } catch (casErr) {
      logOrchestratorError(
        `[contractFailureRoute] defensive CAS to failed threw — relying on applyFailureMode + sweeper recovery`,
        casErr,
        { runId: run.runId, producerTaskId },
      );
    }
    await applyFailureMode(deps, tenantId, run.runId, producerTaskId);
  }
  return { kind: 'reran' };
}

/**
 * Aggregate same-producer `producer-contract` errors into a single
 * `ContractError` for the `system_feedback` binding. Each issue message is
 * prefixed with its `contractName` so the producer keeps per-check context
 * even though the envelope carries one `contractName`.
 */
function aggregateProducerFeedback(errors: ProducerContractError[]): ContractError {
  const first = errors[0]!;
  if (errors.length === 1) return first;
  const mergedIssues = errors.flatMap((e) =>
    e.zodIssues.map((i) => ({ path: i.path, message: `[${e.contractName}] ${i.message}` })),
  );
  return { ...first, zodIssues: mergedIssues };
}

async function pauseConsumerForContractEscalation(
  deps: HarnessDeps,
  args: {
    tenantId: TenantId;
    run: WorkflowRunDetail;
    consumerTaskDef: WorkflowTask;
    consumerTaskRow: WorkflowTaskRow;
    attempt: number;
    errors: ProducerContractError[];
  },
): Promise<void> {
  const { tenantId, run, consumerTaskDef, consumerTaskRow, attempt, errors } = args;
  const bindings = [...new Set(errors.map((e) => e.source.bindAs))].join(', ');
  const detail = errors
    .flatMap((e) => e.zodIssues.map((i) => `${e.contractName}: ${i.message}`))
    .slice(0, 10)
    .join('; ');
  const replaceOutputSchema = consumerTaskDef.outputContract?.schema;
  const contract = buildResumeContract({
    pauseCause: 'task_contract_violation',
    runId: run.runId,
    taskId: consumerTaskDef.taskId,
    taskDef: consumerTaskDef,
    pausedTaskAttempt: attempt,
    resumePrompt:
      `Task "${consumerTaskDef.taskId}" rejected binding(s) "${bindings}", routed to signal_blocked — ` +
      `not producer-fixable (escalate to coach / operator). ${detail}. ` +
      'Resolve the upstream cause, then `replace_output` to override the gate, or `fail` to reject the run.',
    contractErrors: errors as unknown as Array<Record<string, unknown>>,
    ...(replaceOutputSchema
      ? { replaceOutputSchema, expectedTaskOutputSchema: replaceOutputSchema }
      : {}),
  });
  await persistAndPauseConsumer(deps, {
    tenantId,
    run,
    consumerTaskRow,
    attempt,
    contract,
    pauseReason: 'task_contract_violation',
  });
}

async function pauseConsumerRetryBudgetExceeded(
  deps: HarnessDeps,
  args: {
    tenantId: TenantId;
    run: WorkflowRunDetail;
    consumerTaskDef: WorkflowTask;
    consumerTaskRow: WorkflowTaskRow;
    attempt: number;
    producerTaskId: string;
    maxProducerReruns: number;
  },
): Promise<void> {
  const { tenantId, run, consumerTaskDef, consumerTaskRow, attempt, producerTaskId } = args;
  const replaceOutputSchema = consumerTaskDef.outputContract?.schema;
  const contract = buildResumeContract({
    pauseCause: 'retry_budget_exceeded',
    runId: run.runId,
    taskId: consumerTaskDef.taskId,
    taskDef: consumerTaskDef,
    resumePrompt:
      `Producer "${producerTaskId}" was re-run ${String(args.maxProducerReruns)} time(s) but task ` +
      `"${consumerTaskDef.taskId}" still rejects its output — the producer-rerun budget is spent. ` +
      'Author intervention required: `replace_output` to supply a corrected gate result, or `fail` to reject the run.',
    ...(replaceOutputSchema
      ? { replaceOutputSchema, expectedTaskOutputSchema: replaceOutputSchema }
      : {}),
  });
  await persistAndPauseConsumer(deps, {
    tenantId,
    run,
    consumerTaskRow,
    attempt,
    contract,
    pauseReason: 'retry_budget_exceeded',
  });
}

async function persistAndPauseConsumer(
  deps: HarnessDeps,
  args: {
    tenantId: TenantId;
    run: WorkflowRunDetail;
    consumerTaskRow: WorkflowTaskRow;
    attempt: number;
    contract: ReturnType<typeof buildResumeContract>;
    pauseReason: string;
  },
): Promise<void> {
  const { tenantId, run, consumerTaskRow, attempt, contract, pauseReason } = args;
  const tenantIdStr = tenantId as string;
  const consumerTaskId = consumerTaskRow.taskId;

  let contractRef: string;
  try {
    contractRef = await storeWorkflowResumeContract({
      payloadStore: deps.payloadStore,
      tenantId: tenantIdStr,
      runId: run.runId,
      taskId: consumerTaskId,
      attempt,
      contract,
    });
  } catch (err) {
    // Without a stored contract the pause is un-actionable; fail loud so the
    // operator sees a terminal run rather than a silently-stuck one.
    logOrchestratorError(
      `[contractFailureRoute] resume-contract store failed; falling back to failure for run=${run.runId} task=${consumerTaskId}`,
      err,
      { runId: run.runId, taskId: consumerTaskId },
    );
    await applyFailureMode(deps, tenantId, run.runId, consumerTaskId);
    return;
  }

  await emitTaskUpdate(deps, {
    tenantId,
    runId: run.runId,
    taskId: consumerTaskId,
    label: consumerTaskId,
    status: 'paused',
    attempt,
    ...(consumerTaskRow.workerSessionId
      ? { workerSessionId: consumerTaskRow.workerSessionId }
      : {}),
    ...(consumerTaskRow.operationId ? { operationId: consumerTaskRow.operationId } : {}),
    ...(consumerTaskRow.startedAt ? { startedAt: consumerTaskRow.startedAt } : {}),
    completedAt: new Date(),
  }).catch((err: unknown) => {
    logOrchestratorError(
      `[contractFailureRoute] emit WorkflowTaskUpdate(paused) failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
      { runId: run.runId, taskId: consumerTaskId },
    );
  });

  await pauseRunForTask(
    deps,
    tenantId,
    run.runId,
    consumerTaskId,
    attempt,
    contractRef,
    pauseReason,
  );
}

/**
 * Decode the `contractErrors[]` carried on a failed task result's `errorRef`.
 * Handles the inline-op `inline:<b64-json>` envelope and PayloadStore-backed
 * refs. Malformed / unparsable entries are dropped — a non-routable error
 * falls through to the caller's normal fail handling.
 */
async function decodeContractErrors(deps: HarnessDeps, errorRef: string): Promise<ContractError[]> {
  let payload: Record<string, unknown> | null = null;
  try {
    if (errorRef.startsWith('inline:')) {
      const raw = Buffer.from(errorRef.slice('inline:'.length), 'base64').toString('utf8');
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        payload = value as Record<string, unknown>;
      }
    } else {
      const fetched = await deps.payloadStore.retrieve(errorRef as never);
      if (fetched && typeof fetched === 'object' && !Array.isArray(fetched)) {
        payload = fetched as Record<string, unknown>;
      } else if (typeof fetched === 'string') {
        const value = JSON.parse(fetched) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          payload = value as Record<string, unknown>;
        }
      }
    }
  } catch {
    return [];
  }
  const raw = payload?.['contractErrors'];
  if (!Array.isArray(raw)) return [];
  const errors: ContractError[] = [];
  for (const entry of raw) {
    const parsed = ContractErrorSchema.safeParse(entry);
    if (parsed.success) errors.push(parsed.data);
  }
  return errors;
}
