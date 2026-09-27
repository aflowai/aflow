/**
 * Shared helpers for inline op handlers.
 *
 * Reduces boilerplate for emitting step success/error results.
 */
import type {
  ContractError,
  ErrorClassification,
  OperationId,
  SessionId,
  StepExecutionId,
  StepResultMessage,
  TenantId,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { addStepResult, getSessionState } from '@aflow/redis';
import { waitForInput as stepServiceWaitForInput } from '../../../StepService/StepService.js';
import type { StepContext } from '../../../StepService/types.js';
import type { InlineHandlerArgs } from './types.js';

export async function encodeInlineOpOutputRef(
  payloadStore: PayloadStore,
  context: { tenantId: TenantId; runId: SessionId },
  stepExecutionId: StepExecutionId,
  attempt: number,
  outputData: unknown,
): Promise<string> {
  return payloadStore.shouldStore(outputData)
    ? await payloadStore.store({
        tenantId: context.tenantId,
        runId: context.runId,
        stepExecutionId,
        attempt,
        kind: 'output',
        data: outputData,
      })
    : `inline:${Buffer.from(JSON.stringify(outputData)).toString('base64')}`;
}

/**
 * Read an inline op's resolved input.
 *
 * The scheduler picks the form by size — inline under the payload cap, a stored
 * object over it — so which one arrives is not the handler's to predict. The
 * store resolves both, which is the whole reason to go through it: a
 * hand-rolled `inline:` decode reads the small case and answers the large one
 * with nothing, turning an oversized input into a missing one.
 */
export async function readInlineOpInput(args: InlineHandlerArgs): Promise<unknown> {
  return args.payloadStore.retrieve(args.resolvedInputRef);
}

/**
 * As `readInlineOpInput`, narrowed to the object shape operation inputs take,
 * answering `null` for anything it could not produce that shape from.
 *
 * Callers pair this with a typed "input is missing or unparseable" error naming
 * the bindings they expected. That error is more use than the cause of the read
 * failure, which their outer catch would report as a generic internal one — so
 * the ref that cannot be read joins the value that is not an object rather than
 * propagating. Handlers that surface the cause instead read the raw form.
 */
export async function readInlineOpInputRecord(
  args: InlineHandlerArgs,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await readInlineOpInput(args);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function correlation(
  args: InlineHandlerArgs,
): Pick<StepResultMessage, 'sessionId' | 'workflowExecution'> {
  if (args.workflowExecution) {
    return { workflowExecution: args.workflowExecution };
  }
  return { sessionId: args.context.runId };
}

export async function emitStepPaused(
  args: InlineHandlerArgs,
  requestedInputData: Record<string, unknown>,
  startTime: number,
): Promise<void> {
  const {
    redis,
    context,
    stepDef,
    stepExecutionId,
    idempotencyKey,
    resolvedInputRef,
    attempt,
    parentStepExecutionId,
  } = args;
  const requestedInputRef = `inline:${Buffer.from(JSON.stringify(requestedInputData)).toString('base64')}`;
  await addStepResult(redis, {
    messageVersion: 1,
    tenantId: context.tenantId,
    ...correlation(args),
    stepExecutionId,
    parentStepExecutionId: parentStepExecutionId ?? null,
    stepId: stepDef.stepId,
    stepType: stepDef.stepType,
    operationId: stepDef.operation as OperationId,
    attempt,
    idempotencyKey,
    status: 'PAUSED',
    requestedInputRef,
    resolvedInputRef,
    durationMs: Date.now() - startTime,
    traceId: context.traceId,
    finishedAtMs: Date.now(),
  });
}

/**
 * Synchronously park an inline op step that is waiting on an external
 * workflow run and may be woken before the result stream catches up.
 *
 * Routes through `StepService.waitForInput` — the canonical pause
 * mechanism — so the step transitions to PAUSED, the session
 * transitions to PAUSED, recovery events are written, and
 * `SessionPaused` is emitted, all atomically before this returns.
 *
 * Why this exists: `workflow.run.start` (and the resume / retry
 * variants) hand off to `WorkflowRunHarness.startRun` /
 * `dispatchNextOrTerminate` immediately after parking. If the very
 * first task is `type: 'human'`, the harness pauses the workflow run
 * synchronously inside that handoff and calls `notifyWaiters` →
 * `wakeWaiter` (`WorkflowRunHarness.ts`) before any queued PAUSED step
 * result has been consumed. `wakeWaiter` reads step hot state — if
 * it's still `STARTED`, the PAUSED→STARTED reset is skipped, the
 * later-arriving PAUSED applies, and the wakeup's SUCCEEDED gets
 * dropped by `applyResult`'s already-terminal guard. The Helmsman
 * session is then permanently stuck.
 *
 * Calling this helper makes the step durably PAUSED in hot state
 * *before* any harness work runs, so `wakeWaiter`'s reset finds the
 * correct state and the SUCCEEDED wakeup lands cleanly. No PAUSED
 * result is enqueued on the results stream for this path, so there is
 * no late replay to race with the wake.
 *
 * Scope: session-context inline ops only. Asserts
 * `args.workflowExecution === undefined` — workflow-task dispatched
 * inline ops don't have a parent session to pause and shouldn't reach
 * this path.
 */
export async function parkInlineStepForWorkflowWait(
  args: InlineHandlerArgs,
  waitingOn: Record<string, unknown>,
): Promise<void> {
  const { redis, payloadStore, context, stepDef, stepExecutionId, attempt, parentStepExecutionId } =
    args;

  if (args.workflowExecution !== undefined) {
    throw new Error(
      'parkInlineStepForWorkflowWait: must be called from a session inline op, not a workflow task dispatch',
    );
  }

  // The function's documented invariant is that every caller passes the
  // workflow-wait contract shape; assert it rather than silently skipping
  // the marker — a missing marker = no `blockedOn` = the original
  // missing-Pause-button bug, which is hard to spot at runtime.
  if (waitingOn['kind'] !== 'waiting_on_workflow_run' || typeof waitingOn['runId'] !== 'string') {
    throw new Error(
      'parkInlineStepForWorkflowWait: waitingOn must be { kind: "waiting_on_workflow_run", runId: string, ... }',
    );
  }
  const waitingOnRunId = waitingOn['runId'];

  // Load fresh session hot state — `waitForInput` requires it on the
  // StepContext and uses it as the baseline for the recovery
  // `run.status_changed` patch (from→to). A stale snapshot would
  // produce a diverging recovery event.
  const runState = await getSessionState(redis, context.tenantId, context.runId);
  if (!runState) {
    throw new Error(
      `parkInlineStepForWorkflowWait: session ${context.runId} not found in hot state`,
    );
  }

  const requestedInputRef = `inline:${Buffer.from(JSON.stringify(waitingOn)).toString('base64')}`;

  const ctx: StepContext = {
    tenantId: context.tenantId,
    runId: context.runId,
    agentDef: context.agentDefinition,
    traceId: context.traceId,
    stepDef,
    stepExecutionId,
    attempt,
    runState,
    ...(parentStepExecutionId ? { parentStepExecutionId } : {}),
  };

  await stepServiceWaitForInput({ redis, payloadStore }, ctx, [], {
    preBuiltRequestedInputRef: requestedInputRef,
    // `external_dependency` is the existing typed-interrupt category
    // for "waiting on an external system or event" (PauseTypeSchema in
    // `packages/schemas/src/runtime/pauseTypes.ts`). A workflow run is
    // an external dependency from the calling Helmsman session's POV.
    pauseType: 'external_dependency',
    stepStateUpdates: { status: 'PAUSED', endedAt: Date.now() },
    runStateUpdates: { waitingOnWorkflowRunId: waitingOnRunId },
    blockedOn: { kind: 'workflow_run', runId: waitingOnRunId },
  });
}

export async function emitStepSuccess(
  args: InlineHandlerArgs,
  outputData: Record<string, unknown>,
  startTime: number,
): Promise<void> {
  const {
    redis,
    payloadStore,
    context,
    stepDef,
    stepExecutionId,
    idempotencyKey,
    resolvedInputRef,
    attempt,
    parentStepExecutionId,
  } = args;
  const outputRef = await encodeInlineOpOutputRef(
    payloadStore,
    context,
    stepExecutionId,
    attempt,
    outputData,
  );
  await addStepResult(redis, {
    messageVersion: 1,
    tenantId: context.tenantId,
    ...correlation(args),
    stepExecutionId,
    parentStepExecutionId: parentStepExecutionId ?? null,
    stepId: stepDef.stepId,
    stepType: stepDef.stepType,
    operationId: stepDef.operation as OperationId,
    attempt,
    idempotencyKey,
    status: 'SUCCEEDED',
    outputRef,
    resolvedInputRef,
    durationMs: Date.now() - startTime,
    traceId: context.traceId,
    finishedAtMs: Date.now(),
  });
}

/**
 * Public placeholder used in the persisted error payload whenever the step
 * failed with an `internal` classification. Mirrors the agent-facing string
 * produced by `toAgentToolError` (`packages/schemas/src/runtime/errors.ts`)
 * so the activity timeline, the agent tool surface, and the operator view
 * agree on what an internal failure looks like.
 */
const INTERNAL_ERROR_PUBLIC_MESSAGE = 'operation failed due to a system error';

/**
 * Emit a failed step result with inline-encoded error data.
 *
 * Invariant: when `classification === 'internal'`, the persisted `message`
 * is forced to a generic placeholder regardless of what the caller passed.
 * Internal errors represent platform faults (DB drivers, payload-store
 * failures, panics) whose raw text routinely contains SQL, stack traces,
 * or other internals that must not surface in the activity timeline.
 * Callers are expected to log the underlying cause themselves before
 * invoking `emitStepError`.
 */
export async function emitStepError(
  args: InlineHandlerArgs,
  errorCode: string,
  errorMessage: string,
  startTime: number,
  classification: ErrorClassification = 'internal',
  retryable = false,
  /**
   * Optional structured data, surfaced as `error.details` on the
   * `StepResultMessage`. Use this so agents can branch on machine-readable
   * fields (e.g. `details.activeRunIds`) instead of regex-parsing the
   * human-readable `message`.
   */
  details?: unknown,
): Promise<void> {
  const {
    redis,
    context,
    stepDef,
    stepExecutionId,
    idempotencyKey,
    resolvedInputRef,
    attempt,
    parentStepExecutionId,
  } = args;
  const persistedMessage =
    classification === 'internal' ? INTERNAL_ERROR_PUBLIC_MESSAGE : errorMessage;
  const errorData = {
    code: errorCode,
    message: persistedMessage,
    classification,
    retryable,
    timestamp: new Date().toISOString(),
    ...(details !== undefined ? { details } : {}),
  };
  const errorRef = `inline:${Buffer.from(JSON.stringify(errorData)).toString('base64')}`;

  await addStepResult(redis, {
    messageVersion: 1,
    tenantId: context.tenantId,
    ...correlation(args),
    stepExecutionId,
    parentStepExecutionId: parentStepExecutionId ?? null,
    stepId: stepDef.stepId,
    stepType: stepDef.stepType,
    operationId: stepDef.operation as OperationId,
    attempt,
    idempotencyKey,
    status: 'FAILED',
    errorRef,
    error: errorData,
    resolvedInputRef,
    durationMs: Date.now() - startTime,
    traceId: context.traceId,
    finishedAtMs: Date.now(),
  });
}

export async function emitContractFailure(
  args: InlineHandlerArgs,
  code: string,
  errors: ContractError[],
  startTime: number,
): Promise<void> {
  const errorData = {
    code,
    message: `${String(errors.length)} contract violation(s) — see contractErrors for details.`,
    classification: 'validation' as const,
    retryable: false,
    timestamp: new Date().toISOString(),
    contractErrors: errors,
  };
  const errorRef = `inline:${Buffer.from(JSON.stringify(errorData)).toString('base64')}`;
  await addStepResult(args.redis, {
    messageVersion: 1,
    tenantId: args.context.tenantId,
    ...correlation(args),
    stepExecutionId: args.stepExecutionId,
    parentStepExecutionId: args.parentStepExecutionId ?? null,
    stepId: args.stepDef.stepId,
    stepType: args.stepDef.stepType,
    operationId: args.stepDef.operation as OperationId,
    attempt: args.attempt,
    idempotencyKey: args.idempotencyKey,
    status: 'FAILED',
    errorRef,
    error: errorData,
    resolvedInputRef: args.resolvedInputRef,
    durationMs: Date.now() - startTime,
    traceId: args.context.traceId,
    finishedAtMs: Date.now(),
  });
}
