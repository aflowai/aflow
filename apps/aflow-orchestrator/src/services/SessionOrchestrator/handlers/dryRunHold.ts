/**
 * The orchestrator half of a dry run's write hold. A platform write a dry run
 * asks for — memory, campaign, learnings and every other write-mode operation
 * `dryRunWriteDisposition` holds — never dispatches: it succeeds at once with
 * the held result, and its result message carries the held write for the run
 * to record. API writes are held by the API executor, which reads the tier.
 *
 * The hold is a gate every dispatch path passes, not one entry point. A
 * session's step meets `gateSessionStepInDryRun` when it is first scheduled
 * and again when a retry or delayed-start timer fires. An operation task meets
 * `holdOperationTaskInDryRun` when it is claimed and again on each poll cycle
 * its timer dispatches.
 */
import { recordDryRunHeldWrite, type Database } from '@aflow/database';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import { addStepResult, getSessionDryRunLink, getSessionDryRunOf } from '@aflow/redis';
import {
  buildDryRunHeldOutput,
  dryRunHoldsHarnessRun,
  dryRunWriteDisposition,
  previewWrite,
  type AflowError,
  type DryRunHeldWrite,
  type IdempotencyKey,
  type OperationId,
  type SessionId,
  type StepExecutionId,
  type StepId,
  type StepResultMessage,
  type StepType,
  type TenantId,
  type TraceId,
  type WorkflowExecutionRef,
} from '@aflow/schemas';
import { encodeInlineOpOutputRef } from './inlineOps/helpers.js';
import type { InlineHandlerArgs } from './inlineOps/types.js';
import type { ApplyResultParams } from '../types.js';

/**
 * Whether the orchestrator may hold `operationId` in a dry run, before it has
 * read the step's input. A step this answers false for dispatches whatever
 * the session is.
 */
export function orchestratorMayHoldInDryRun(operationId: string): boolean {
  const disposition = dryRunWriteDisposition(operationId);
  return disposition === 'hold' || disposition === 'harness';
}

/**
 * Whether a dry run holds `operationId` here, before it dispatches. A harness
 * run is held when its resolved input asks for a browser, and when that input
 * cannot be read.
 */
export async function orchestratorHoldsInDryRun(
  payloadStore: PayloadStore,
  operationId: string,
  resolvedInputRef: string,
): Promise<boolean> {
  const disposition = dryRunWriteDisposition(operationId);
  if (disposition === 'hold') return true;
  if (disposition !== 'harness') return false;
  try {
    return dryRunHoldsHarnessRun(await payloadStore.retrieve(resolvedInputRef));
  } catch {
    return true;
  }
}

/**
 * What a session's step knows of the dry run it works for. `unknown` means
 * the session state could not be read, so a write must not dispatch live.
 */
export type SessionDryRunOf =
  { kind: 'live' } | { kind: 'dry_run'; dryRunOf: string } | { kind: 'unknown'; reason: string };

/**
 * The dry run a session works for, from the state the caller read. When that
 * read failed, the one field is read again. A second failure answers
 * `unknown`, and the caller fails the write rather than dispatch it.
 */
export async function resolveSessionDryRunOf(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  state: { dryRunOf?: string | undefined } | null | undefined,
  stateReadError: unknown,
): Promise<SessionDryRunOf> {
  if (stateReadError === undefined) {
    return state?.dryRunOf !== undefined
      ? { kind: 'dry_run', dryRunOf: state.dryRunOf }
      : { kind: 'live' };
  }
  try {
    const dryRunOf = await getSessionDryRunOf(redis, tenantId, sessionId);
    return dryRunOf !== null ? { kind: 'dry_run', dryRunOf } : { kind: 'live' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'unknown', reason: msg };
  }
}

/**
 * The failure of a write whose session state cannot be read. It is not
 * retryable, and its classification is outside every retry policy's list. A
 * retry would dispatch the write again, and the write must never be sent.
 */
export function dryRunStateUnavailableError(reason: string): AflowError {
  return {
    code: 'DRY_RUN_STATE_UNAVAILABLE',
    message: `The session's state could not be read, so whether it works for a dry run is unknown. The write was not sent: ${reason}`,
    classification: 'internal',
    retryable: false,
    timestamp: new Date().toISOString(),
  };
}

/** What the dry-run gate decided for one dispatch of a session's step. */
export type SessionDryRunGate = 'dispatch' | 'held' | 'refused';

/**
 * The dry-run gate of a session's step. Every path that dispatches one passes
 * it: the first schedule, and each retry or delayed start a timer fires. A
 * held write succeeds with the held result. A write whose session state cannot
 * be read fails through `applyResult` and is never sent. Anything else
 * dispatches.
 */
export async function gateSessionStepInDryRun(
  args: InlineHandlerArgs,
  session: {
    state: { dryRunOf?: string | undefined } | null | undefined;
    stateReadError: unknown;
  },
  applyResult: (params: ApplyResultParams) => Promise<void>,
): Promise<SessionDryRunGate> {
  const operationId = args.stepDef.operation;
  if (!orchestratorMayHoldInDryRun(operationId)) return 'dispatch';
  const dryRun = await resolveSessionDryRunOf(
    args.redis,
    args.context.tenantId,
    args.context.runId,
    session.state,
    session.stateReadError,
  );
  if (dryRun.kind === 'unknown') {
    const error = dryRunStateUnavailableError(dryRun.reason);
    await applyResult({
      result: {
        messageVersion: 1,
        tenantId: args.context.tenantId,
        sessionId: args.context.runId,
        stepExecutionId: args.stepExecutionId,
        ...(args.parentStepExecutionId !== undefined
          ? { parentStepExecutionId: args.parentStepExecutionId }
          : {}),
        stepId: args.stepDef.stepId,
        stepType: args.stepDef.stepType,
        operationId,
        attempt: args.attempt,
        idempotencyKey: args.idempotencyKey,
        status: 'FAILED',
        errorRef: `inline:${Buffer.from(JSON.stringify(error)).toString('base64')}`,
        error,
        traceId: args.context.traceId,
        finishedAtMs: Date.now(),
      },
      messageId: `synthetic:dry-run-state-unavailable:${args.stepExecutionId}:${String(args.attempt)}`,
    });
    return 'refused';
  }
  if (
    dryRun.kind === 'dry_run' &&
    (await orchestratorHoldsInDryRun(args.payloadStore, operationId, args.resolvedInputRef))
  ) {
    await emitDryRunHeldResult(args, dryRun.dryRunOf);
    return 'held';
  }
  return 'dispatch';
}

/** One dispatch of a claimed workflow operation task, as the hold reads it. */
export interface OperationTaskHoldArgs {
  redis: Redis;
  payloadStore: PayloadStore;
  tenantId: TenantId;
  workflowExecution: WorkflowExecutionRef;
  /** The worker session id the claim allocated, which is the step execution id. */
  stepExecutionId: StepExecutionId;
  operationId: string;
  inputRef: string;
  attempt: number;
  traceId: TraceId;
  spaceId?: string;
}

/**
 * Hold one dispatch of a dry run's operation task, before any inline handler,
 * timer or executor could run it. Every path that dispatches an operation task
 * passes here: the claim, a retried attempt and each poll cycle a timer fires.
 * Answers whether the task was held.
 */
export async function holdOperationTaskInDryRun(
  args: OperationTaskHoldArgs,
  dryRun: boolean,
): Promise<boolean> {
  if (!dryRun) return false;
  if (!(await orchestratorHoldsInDryRun(args.payloadStore, args.operationId, args.inputRef))) {
    return false;
  }
  const { workflowExecution } = args;
  await emitDryRunHeldResult(
    {
      redis: args.redis,
      payloadStore: args.payloadStore,
      // Synthetic — an operation task has no session. `runId` carries the
      // worker session id, and the workflow run id rides `workflowExecution`.
      context: {
        tenantId: args.tenantId,
        runId: args.stepExecutionId as string as SessionId,
        agentDefinition: {
          flowId: 'workflow-task-inline',
          flowVersion: '1',
          steps: [],
          metadata: { name: '', description: '' },
        } as never,
        traceId: args.traceId,
        ...(args.spaceId !== undefined ? { spaceId: args.spaceId } : {}),
      },
      stepDef: {
        stepId: workflowExecution.taskId as StepId,
        stepType: args.operationId.split('.')[0] as StepType,
        operation: args.operationId as OperationId,
        config: {},
        tags: ['dynamic', `_taskId:${workflowExecution.taskId}`],
        optional: false,
        onSuccess: { next: [] },
        onFailure: { next: [] },
      },
      stepExecutionId: args.stepExecutionId,
      idempotencyKey: workflowExecution.dispatchAttemptToken as IdempotencyKey,
      resolvedInputRef: args.inputRef,
      attempt: args.attempt,
      scheduledAtMs: Date.now(),
      workflowExecution,
    },
    workflowExecution.runId,
  );
  return true;
}

function stringAt(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field !== '' ? field : undefined;
}

/**
 * Where a held platform write would have gone, and the addressing fields the
 * held result echoes. A memory write names its path, a campaign or skill write
 * its slug, and any other write its operation.
 */
export function describeHeldPlatformWrite(
  operationId: string,
  input: unknown,
): { target: string; echo: Record<string, unknown> } {
  const nested =
    input !== null && typeof input === 'object'
      ? (input as Record<string, unknown>)['target']
      : undefined;
  const path =
    stringAt(input, 'path') ?? stringAt(nested, 'path') ?? stringAt(input, 'toMemoryPath');
  if (path !== undefined) {
    return { target: `${operationId} ${path}`, echo: { path } };
  }
  const slug = stringAt(input, 'slug');
  if (slug !== undefined) return { target: `${operationId} ${slug}`, echo: { slug } };
  return { target: operationId, echo: {} };
}

/**
 * Hold one platform write of `dryRunOf`: succeed the step with the held result
 * and nothing executed. The result rides the results stream, as an inline
 * operation's does, so it is applied and recorded on the one path every
 * result takes.
 */
export async function emitDryRunHeldResult(
  args: InlineHandlerArgs,
  dryRunOf: string,
): Promise<DryRunHeldWrite> {
  const input = await args.payloadStore.retrieve(args.resolvedInputRef);
  const operationId = args.stepDef.operation;
  const { target, echo } = describeHeldPlatformWrite(operationId, input);
  const preview = previewWrite(input);
  const held: DryRunHeldWrite = {
    runId: dryRunOf,
    operationId,
    target,
    ...(preview !== undefined ? { preview } : {}),
  };
  const outputRef = await encodeInlineOpOutputRef(
    args.payloadStore,
    args.context,
    args.stepExecutionId,
    args.attempt,
    buildDryRunHeldOutput(held, echo),
  );
  await addStepResult(args.redis, {
    messageVersion: 1,
    tenantId: args.context.tenantId,
    ...(args.workflowExecution
      ? { workflowExecution: args.workflowExecution }
      : { sessionId: args.context.runId }),
    stepExecutionId: args.stepExecutionId,
    parentStepExecutionId: args.parentStepExecutionId ?? null,
    stepId: args.stepDef.stepId,
    stepType: args.stepDef.stepType,
    operationId,
    attempt: args.attempt,
    idempotencyKey: args.idempotencyKey,
    status: 'SUCCEEDED',
    outputRef,
    resolvedInputRef: args.resolvedInputRef,
    heldWrite: held,
    durationMs: 0,
    traceId: args.context.traceId,
    finishedAtMs: Date.now(),
  });
  return held;
}

/**
 * Record the write a result says a dry run held, on the dry run it names. Every
 * result passes here before it is applied, whichever tier held the write, so
 * the run's detail lists the writes of its operation tasks and of the sessions
 * its agent tasks ran in alike. A redelivered result records nothing twice.
 *
 * A session step's write is recorded with the task its session works for, read
 * from the session's `dryRunTaskId`. That field is inherited through
 * delegation and belongs to one attempt's session, so the task is named for a
 * write held in a delegated session and in an attempt a retry has replaced.
 */
export async function recordHeldWriteOfResult(
  db: Database,
  redis: Redis,
  result: Pick<
    StepResultMessage,
    'tenantId' | 'heldWrite' | 'stepExecutionId' | 'attempt' | 'sessionId' | 'workflowExecution'
  >,
): Promise<void> {
  if (result.heldWrite === undefined) return;
  const taskId =
    result.workflowExecution !== undefined
      ? result.workflowExecution.taskId
      : await sessionTaskOfHeldWrite(redis, result.tenantId, result.sessionId, result.heldWrite);
  await recordDryRunHeldWrite(db, result.tenantId, {
    held: result.heldWrite,
    stepExecutionId: result.stepExecutionId,
    attempt: result.attempt,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
  });
}

async function sessionTaskOfHeldWrite(
  redis: Redis,
  tenantId: string,
  sessionId: string | undefined,
  held: DryRunHeldWrite,
): Promise<string | undefined> {
  if (sessionId === undefined) return undefined;
  const link = await getSessionDryRunLink(redis, tenantId, sessionId);
  return link?.dryRunOf === held.runId ? link.dryRunTaskId : undefined;
}
