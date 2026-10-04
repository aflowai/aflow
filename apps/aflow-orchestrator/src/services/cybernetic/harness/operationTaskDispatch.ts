import type {
  IdempotencyKey,
  OperationId,
  RunTrigger,
  SessionId,
  StepExecutionId,
  StepId,
  StepType,
  TenantId,
  TraceId,
} from '@aflow/schemas';
import { SNOOZE_OPERATION_ID, resolveSnoozeDelayMs } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { scheduleShardTimer } from '@aflow/redis';
import { dispatchInlineOp } from '../../SessionOrchestrator/handlers/dispatchInlineOp.js';
import { dispatchOrWaitOnExecutor } from '../../SessionOrchestrator/scheduling/executorWait.js';
import {
  isInlineOperation,
  isWorkflowTaskSafeInlineOperation,
} from '../../SessionOrchestrator/helpers/inlineOperations.js';
import type { HarnessDeps } from './types.js';

/**
 * Default `completion_pending` supervision window — how long the sweeper
 * waits for a dispatched task before treating the attempt as orphaned.
 */
export const DISPATCH_PENDING_INTERVAL_MS = 60_000;

export async function resolveOperationTaskSnoozeDelayMs(
  payloadStore: PayloadStore,
  operationId: string,
  inputRef: string,
): Promise<number> {
  if (operationId !== SNOOZE_OPERATION_ID) return 0;
  const snoozeInput = await payloadStore.retrieve(inputRef);
  return resolveSnoozeDelayMs(snoozeInput);
}

/**
 * `completion_pending` dueAt for an operation-task claim. For snooze, the
 * supervision window accounts for the delay
 * (dueAt = now + durationMs + DISPATCH_PENDING_INTERVAL_MS) so the sweeper
 * doesn't reap a healthy snooze mid-wait. Non-snooze tasks pass 0.
 */
export function operationTaskClaimDueAt(snoozeDelayMs: number): Date {
  return new Date(Date.now() + snoozeDelayMs + DISPATCH_PENDING_INTERVAL_MS);
}

/** How a claimed operation task was dispatched (for caller logging). */
export type OperationTaskDispatchMode = 'snooze_timer' | 'inline' | 'enqueued' | 'executor_wait';

/** How a dispatch went, as the dispatcher's log line says it. */
export function describeOperationTaskDispatch(
  mode: OperationTaskDispatchMode,
  snoozeDelayMs: number,
): string {
  switch (mode) {
    case 'snooze_timer':
      return `scheduled snooze timer (+${String(snoozeDelayMs)}ms) for`;
    case 'inline':
      return 'ran inline';
    case 'enqueued':
      return 'enqueued';
    case 'executor_wait':
      return 'waiting for its executor to dispatch';
  }
}

export interface DispatchClaimedOperationTaskArgs {
  tenantId: TenantId;
  runId: string;
  taskId: string;
  attempt: number;
  /** The claim's per-attempt token — becomes the job/result idempotency key. */
  dispatchAttemptToken: string;
  operationId: string;
  /** Pre-allocated worker session id (= step execution id) from the claim. */
  workerSessionId: string;
  inputRef: string;
  traceId: TraceId;
  spaceId: string;
  /** Clamped snooze delay resolved pre-claim; 0 for non-snooze operations. */
  snoozeDelayMs: number;
  credentialOwnerId?: string;
  /** The workflow anchor's root trigger, from `resolveWorkflowTaskAuthority`. */
  rootTrigger?: RunTrigger;
}

/**
 * POST-CLAIM dispatch of a claimed workflow operation task. Throws on
 * dispatch failure — callers run this inside their post-claim try/catch and
 * drive `postClaimFailure` + `PostClaimDispatchError`. A missing executor is
 * not one: the task waits for it on an `executor_wait` timer, inside the
 * claim's completion_pending supervision, which bumps rather than escalates
 * for longer than the wait's looks span.
 */
export async function dispatchClaimedOperationTask(
  deps: Pick<HarnessDeps, 'redis' | 'payloadStore'>,
  args: DispatchClaimedOperationTaskArgs,
): Promise<OperationTaskDispatchMode> {
  const {
    tenantId,
    runId,
    taskId,
    attempt,
    dispatchAttemptToken,
    operationId,
    workerSessionId,
    inputRef,
    traceId,
    spaceId,
    snoozeDelayMs,
    credentialOwnerId,
    rootTrigger,
  } = args;
  const stepType = operationId.split('.')[0] as StepType;
  const workflowExecution = { runId, taskId, attempt, dispatchAttemptToken };

  if (operationId === SNOOZE_OPERATION_ID) {
    await scheduleShardTimer(deps.redis, {
      tenantId,
      workflowExecution,
      stepExecutionId: workerSessionId as StepExecutionId,
      stepId: taskId as StepId,
      operationId: operationId as OperationId,
      stepType,
      reason: 'delayed_start',
      attempt,
      inputRef,
      traceId,
      dueAtMs: Date.now() + snoozeDelayMs,
      ...(credentialOwnerId !== undefined ? { credentialOwnerId } : {}),
      spaceId,
      ...(rootTrigger !== undefined ? { rootTrigger } : {}),
    });
    return 'snooze_timer';
  }

  if (isInlineOperation(operationId)) {
    if (!isWorkflowTaskSafeInlineOperation(operationId)) {
      throw new Error(
        `inline operation '${operationId}' on task '${taskId}' is not on the workflow-task safelist (its handler does not emit workflowExecution-correlated results). Use a different operation, or add it to WORKFLOW_TASK_SAFE_INLINE_OPERATIONS once the handler is correlation-aware.`,
      );
    }
    // Inline operation tasks (skill.compose.*, capability.validate.*, etc.)
    // have no external executor. Run the inline handler in-process; the
    // helper emits a StepResultMessage with `workflowExecution` set, which
    // ResultConsumer routes to `onWorkflowTaskComplete` (same shape as
    // executor-dispatched operation tasks). Failures inside the handler are
    // surfaced by the handler itself via emitStepError; unhandled throws
    // propagate to the caller's post-claim failure path.
    await dispatchInlineOp(
      deps.redis,
      deps.payloadStore,
      {
        tenantId,
        // Synthetic — there is no session for a workflow-task inline
        // dispatch. Handlers that read `args.context.runId` get the
        // worker session id; handlers that need the workflow-run id
        // read it from `args.workflowExecution.runId`.
        runId: workerSessionId as SessionId,
        agentDefinition: {
          flowId: 'workflow-task-inline',
          flowVersion: '1',
          steps: [],
          metadata: { name: '', description: '' },
        } as never,
        traceId,
        spaceId,
      },
      {
        stepId: taskId as StepId,
        stepType,
        operation: operationId as OperationId,
        config: {},
        tags: ['dynamic', `_taskId:${taskId}`],
        optional: false,
        onSuccess: { next: [] },
        onFailure: { next: [] },
      },
      workerSessionId as StepExecutionId,
      dispatchAttemptToken as IdempotencyKey,
      inputRef,
      attempt,
      Date.now(),
      undefined,
      workflowExecution,
    );
    return 'inline';
  }

  // Enqueue the workflow-task job. Schema invariant guarantees this path
  // uses workflowExecution + no sessionId.
  const dispatched = await dispatchOrWaitOnExecutor(deps.redis, {
    messageVersion: 1,
    tenantId,
    workflowExecution,
    stepExecutionId: workerSessionId as StepExecutionId,
    stepId: taskId as StepId,
    stepType,
    operationId: operationId as OperationId,
    attempt,
    idempotencyKey: dispatchAttemptToken as IdempotencyKey,
    inputRef,
    traceId,
    scheduledAtMs: Date.now(),
    ...(credentialOwnerId !== undefined ? { credentialOwnerId } : {}),
    spaceId,
    ...(rootTrigger !== undefined ? { rootTrigger } : {}),
  });
  return dispatched.kind === 'waiting' ? 'executor_wait' : 'enqueued';
}
