import {
  buildResumeContract,
  contractViolationHasResolution,
  projectTaskOutput,
  storeWorkflowResumeContract,
  type WorkflowTaskRow,
} from '@aflow/cybernetic-runtime';
import { inferTaskType, POLL_RESERVED_OUTPUT_KEY } from '@aflow/schemas';
import type { SessionId, StepExecutionId, TenantId, Workflow, WorkflowTask } from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import {
  annotateWithConsumers,
  validateAgentOutput,
} from '../../SessionOrchestrator/handlers/inlineOps/agentOutputValidator.js';
import type { HarnessDeps, WorkflowExecutionRef, WorkflowTaskOutcome } from './types.js';

export interface ApplyOpTaskOutputContractArgs {
  tenantId: TenantId;
  taskRow: WorkflowTaskRow;
  /** Resolved workflow definition (null when unresolvable — gate passes through). */
  workflow: Workflow | null;
  /** Resolved task definition (null when unresolvable — gate passes through). */
  taskDef: WorkflowTask | null;
  workflowExecution: WorkflowExecutionRef;
  outcome: Extract<WorkflowTaskOutcome, { kind: 'succeeded' }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The op's own account of what went wrong, when it has one.
 *
 * A projection failure or a schema diff describes the shape that is missing;
 * neither can say that the peer refused the call. An output carrying a non-2xx
 * `statusCode` is an op reporting a failed call, and restating that as a
 * data-shape problem sends the operator hunting for a binding bug that isn't
 * there — so that reading leads, carrying the peer's own text from wherever the
 * response body put it.
 */
function describeOpFailure(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;

  const firstText = (candidate: unknown): string | undefined => {
    if (!isRecord(candidate)) return undefined;
    for (const key of ['message', 'error', 'summary']) {
      const text = candidate[key];
      if (typeof text === 'string' && text.length > 0) return text;
    }
    return undefined;
  };

  const status = value['statusCode'];
  if (typeof status === 'number' && (status < 200 || status > 299)) {
    const detail = firstText(value) ?? firstText(value['data']) ?? firstText(value['body']);
    return `The call failed with HTTP ${String(status)}${detail ? `: ${detail}` : ''}`;
  }

  const summary = value['summary'];
  if (typeof summary === 'string' && summary.length > 0) return summary;
  const message = value['message'];
  if (typeof message === 'string' && message.length > 0) return message;
  return undefined;
}

/** An op's own account, closed as a sentence once: a summary may already end in one. */
function asSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function safeIsOperationTask(task: WorkflowTask): boolean {
  try {
    return inferTaskType(task) === 'operation';
  } catch {
    return false;
  }
}

/**
 * Apply projection + the output validation invariant to a SUCCEEDED
 * operation-task outcome. Non-operation tasks (Runner terminals validate in
 * `validateRunnerOutputContract.ts`), tasks without a projection or an
 * `outputContract.schema`, and unresolvable definitions pass straight
 * through. Never throws.
 */
export async function applyOpTaskOutputContract(
  deps: HarnessDeps,
  args: ApplyOpTaskOutputContractArgs,
): Promise<WorkflowTaskOutcome> {
  const { tenantId, taskRow, workflow, taskDef, workflowExecution, outcome } = args;
  const { runId, taskId, attempt } = workflowExecution;

  if (!taskDef || !safeIsOperationTask(taskDef)) return outcome;
  const projection = taskDef.outputProjection;
  const schema = taskDef.outputContract?.schema;
  if (!projection && !schema) return outcome;

  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:opTaskOutputContract',
    runId,
    taskId,
    attempt,
  });
  const tenantIdStr = tenantId as string;

  // 1. Retrieve the raw op output (for polled tasks this is the
  //    `_poll`-stamped terminal payload — raw + reserved stamp).
  let rawOutput: unknown;
  try {
    rawOutput = await deps.payloadStore.retrieve(outcome.outputRef as never);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (projection) {
      // With a declared projection, completing on the RAW ref would silently
      // change the task's output shape (skipping projection AND validation) —
      // same argument as PROJECTION_PERSIST_FAILED below. Loud, transient
      // (a payload-store flake), retryable.
      log.warn(
        `[opTaskOutputContract] raw output retrieve failed with a declared projection; failing transient: ${msg}`,
      );
      return {
        kind: 'failed',
        failureReason: `Failed to retrieve the raw op output to apply outputProjection: ${msg}.`,
        errorCode: 'PROJECTION_SOURCE_UNAVAILABLE',
        errorClassification: 'transient',
        errorRetryable: true,
      };
    }
    log.warn(
      `[opTaskOutputContract] payloadStore.retrieve failed; passing through (validation-only task): ${msg}`,
    );
    return outcome;
  }

  // 2. Projection — task output becomes EXACTLY the projected object.
  let taskOutput: unknown = rawOutput;
  let projectedRef: string | undefined;
  if (projection) {
    // `fromInput` echo fields read the task's resolved op input (stored at
    // dispatch on the task row). Only fetched when an echo field exists.
    let resolvedInput: Record<string, unknown> | null = null;
    const hasEcho = Object.values(projection).some((spec) => 'fromInput' in spec);
    if (hasEcho && taskRow.inputRef) {
      try {
        const fetched = await deps.payloadStore.retrieve(taskRow.inputRef as never);
        // A non-record payload is a deterministic data-shape problem — fall
        // through with null so the declared echo fails loud (PROJECTION_FAILED).
        resolvedInput = isRecord(fetched) ? fetched : null;
      } catch (err) {
        // Same fault class as the raw-output read above: an infra flake on a
        // declared-projection input must not masquerade as a validation
        // failure (PROJECTION_FAILED) — fail transient/retryable instead.
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          `[opTaskOutputContract] input retrieve for fromInput echo failed; failing transient: ${msg}`,
        );
        return {
          kind: 'failed',
          failureReason: `Failed to retrieve the task's resolved input for the fromInput echo: ${msg}.`,
          errorCode: 'PROJECTION_SOURCE_UNAVAILABLE',
          errorClassification: 'transient',
          errorRetryable: true,
        };
      }
    }

    const projected = projectTaskOutput(projection, rawOutput, resolvedInput);
    if (!projected.ok) {
      // §4.3 failure semantics — onMissing: 'error' is LOUD: a structured
      // PROJECTION_FAILED naming each field and path, surfaced through the
      const lines = projected.failures.map((f) => `field "${f.field}" (${f.source}): ${f.reason}`);
      const failureMessage = `PROJECTION_FAILED: ${lines.join('; ')}`;
      const opFailure = describeOpFailure(rawOutput);
      log.info(
        `[opTaskOutputContract] task=${taskId} projection FAILED: ${lines.join('; ')}${opFailure ? ` (${opFailure})` : ''}`,
      );
      return await pauseForViolation(deps, log, {
        tenantId: tenantIdStr,
        workflowExecution,
        taskDef,
        taskOutputRef: outcome.outputRef,
        errorCode: 'PROJECTION_FAILED',
        failureMessage,
        ...(opFailure ? { opFailure } : {}),
        resumePrompt:
          `${opFailure ? `${asSentence(opFailure)} ` : ''}Task "${taskId}" outputProjection could not resolve: ${lines.join('; ')}. ` +
          'Supply the projected output via replace_output, or retry via re_execute if the op result was transiently incomplete.',
        ...(schema ? { expectedTaskOutputSchema: schema, replaceOutputSchema: schema } : {}),
        errorPayloadData: {
          code: 'PROJECTION_FAILED',
          message: failureMessage,
          classification: 'validation',
          producerTaskId: taskId,
          attemptedOutputRef: outcome.outputRef,
          failures: projected.failures,
        },
        failedOutputPreview: rawOutput,
      });
    }

    // Carry the reserved `_poll` stamp (§4.2 terminal) onto the projected
    // object — projection cannot declare `_poll` (graph rule), so no clobber.
    const value = projected.value;
    if (isRecord(rawOutput) && POLL_RESERVED_OUTPUT_KEY in rawOutput) {
      value[POLL_RESERVED_OUTPUT_KEY] = rawOutput[POLL_RESERVED_OUTPUT_KEY];
    }
    taskOutput = value;

    // Persist the projected object as a NEW task-output payload. Distinct
    // stepExecutionId — never the executor's step ref (stays raw), never the
    // bare taskId (resume contracts live there), never `<taskId>:poll`.
    try {
      projectedRef = await deps.payloadStore.store({
        tenantId,
        runId: runId as SessionId,
        stepExecutionId: `${taskId}:projected` as StepExecutionId,
        attempt,
        kind: 'output',
        data: value,
      });
    } catch (err) {
      // The projected shape IS the task's contract surface — completing with
      // the raw ref would hand downstream bindings a shape the contract
      // never promised. Loud, transient (a payload-store flake), retryable.
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[opTaskOutputContract] projected payload store failed: ${msg}`);
      return {
        kind: 'failed',
        failureReason: `Failed to persist the projected task output: ${msg}.`,
        errorCode: 'PROJECTION_PERSIST_FAILED',
        errorClassification: 'transient',
        errorRetryable: true,
      };
    }
  }

  // 3. Output validation invariant — projected when a projection exists,
  //    raw otherwise. The platform-reserved `_poll` stamp is excluded from
  //    the validated view (harness metadata, not author contract).
  if (schema) {
    let contractView: unknown = taskOutput;
    if (isRecord(taskOutput) && POLL_RESERVED_OUTPUT_KEY in taskOutput) {
      const { [POLL_RESERVED_OUTPUT_KEY]: _poll, ...rest } = taskOutput;
      contractView = rest;
    }

    let validation: ReturnType<typeof validateAgentOutput>;
    try {
      validation = validateAgentOutput(contractView, schema);
    } catch (err) {
      // Malformed schema is a configuration bug — fail closed (mirrors the
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        `[opTaskOutputContract] schema compile threw for task=${taskId}: ${msg} — converting to failed(OUTPUT_SCHEMA_INVALID)`,
      );
      return {
        kind: 'failed',
        failureReason: `The task's outputContract.schema is malformed and could not be compiled: ${msg}.`,
        errorCode: 'OUTPUT_SCHEMA_INVALID',
        errorClassification: 'configuration',
        errorRetryable: false,
      };
    }

    if (!validation.ok) {
      const annotated = workflow
        ? annotateWithConsumers(validation.rawErrors, workflow, taskId)
        : validation.formatted;
      const lines = annotated.slice(0, 10);
      const failureMessage = `Output contract violation: ${lines.join('; ')}. ${validation.actualDesc}.`;
      const selfSummary = describeOpFailure(contractView);
      log.info(
        `[opTaskOutputContract] task=${taskId} ${projection ? 'projected' : 'raw'} output validation FAILED; pausing for task_contract_violation: ${lines.join('; ')}`,
      );
      return await pauseForViolation(deps, log, {
        tenantId: tenantIdStr,
        workflowExecution,
        taskDef,
        // The attempted task output: projected payload when one was written,
        // else the raw ref — the replace_output merge base.
        taskOutputRef: projectedRef ?? outcome.outputRef,
        errorCode: 'OUTPUT_CONTRACT_VIOLATION',
        failureMessage,
        ...(selfSummary ? { opFailure: selfSummary } : {}),
        resumePrompt:
          `${selfSummary ? `${asSentence(selfSummary)} ` : ''}Task "${taskId}" ${projection ? 'projected ' : ''}output failed its declared outputContract.schema. ` +
          `${lines.join('; ')}. ${validation.actualDesc}. ` +
          'Fix the output via replace_output or retry via re_execute.',
        expectedTaskOutputSchema: schema,
        replaceOutputSchema: schema,
        errorPayloadData: {
          code: 'OUTPUT_CONTRACT_VIOLATION',
          message: failureMessage,
          classification: 'validation',
          producerTaskId: taskId,
          attemptedOutputRef: projectedRef ?? outcome.outputRef,
          formatted: validation.formatted,
          actualDesc: validation.actualDesc,
        },
        failedOutputPreview: contractView,
      });
    }
  }

  return projectedRef !== undefined ? { kind: 'succeeded', outputRef: projectedRef } : outcome;
}

// ============================================================================

interface PauseForViolationArgs {
  tenantId: string;
  workflowExecution: WorkflowExecutionRef;
  taskDef: WorkflowTask;
  taskOutputRef: string;
  errorCode: 'PROJECTION_FAILED' | 'OUTPUT_CONTRACT_VIOLATION';
  failureMessage: string;
  resumePrompt: string;
  expectedTaskOutputSchema?: Record<string, unknown>;
  replaceOutputSchema?: Record<string, unknown>;
  /**
   * Structured error payload persisted alongside the pause (kind 'error')
   * so retry visibility stays consistent with executor-side AflowError
   * surfacing — the failed-fallback outcome carries it as `errorRef`.
   */
  errorPayloadData: Record<string, unknown>;
  failedOutputPreview?: unknown;
  /** The op's own account of the failure, when it reported one. */
  opFailure?: string;
}

/**
 * Build + persist the `task_contract_violation` resume contract and return
 * a paused outcome. Contract-store failure degrades to a structured failed
 * outcome (same code) so the violation is never silently swallowed.
 */
async function pauseForViolation(
  deps: HarnessDeps,
  log: ReturnType<ReturnType<typeof getOrchestratorLogger>['child']>,
  args: PauseForViolationArgs,
): Promise<WorkflowTaskOutcome> {
  const { workflowExecution } = args;

  // Decided before the error payload is written, because the payload carries
  // `retryable` and the outcome carries `errorRetryable`: the agent reads the
  // payload and the run surface reads the row, so the two disagreeing would
  // invite a retry of the very op the pause was withholding.
  const hasResolution = contractViolationHasResolution({
    taskDef: args.taskDef,
    pausedTaskAttempt: workflowExecution.attempt,
    ...(args.replaceOutputSchema ? { replaceOutputSchema: args.replaceOutputSchema } : {}),
  });

  // Best-effort structured error payload (kind 'error' — never assigned to
  // an outputRef; mirrors validateRunnerOutputContract's discipline).
  let errorRef: string | undefined;
  try {
    errorRef = await deps.payloadStore.store({
      tenantId: args.tenantId as TenantId,
      runId: workflowExecution.runId as SessionId,
      stepExecutionId: workflowExecution.taskId as StepExecutionId,
      attempt: workflowExecution.attempt,
      kind: 'error',
      data: { ...args.errorPayloadData, retryable: hasResolution },
    });
  } catch (storeErr) {
    log.warn(
      `[opTaskOutputContract] failed to persist error payload; outcome carries no errorRef: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`,
    );
  }

  // A violation with no resolution is a failure wearing a pause's clothes: the
  // contract would advertise `replace_output` with no schema saying what to
  // replace, `re_execute` is withheld from a task that is not
  // `retryability: safe`, and `fail` is all that is left. Failing here hands
  // the caller the outcome now, through the normal failure path, instead of
  // resting the run on a resolver that has nothing to decide.
  if (!hasResolution) {
    log.info(
      `[opTaskOutputContract] task=${workflowExecution.taskId} ${args.errorCode} has no resolution (no replaceOutputSchema, re_execute not advertisable); failing instead of pausing`,
    );
    const instruction = args.taskDef.failureInstruction;
    return {
      kind: 'failed',
      ...(errorRef !== undefined ? { errorRef } : {}),
      failureReason: [
        ...(args.opFailure ? [asSentence(args.opFailure)] : []),
        ...(instruction ? [instruction] : []),
        args.failureMessage,
      ].join(' '),
      errorCode: args.errorCode,
      errorClassification: 'validation',
      errorRetryable: false,
    };
  }

  const contract = buildResumeContract({
    pauseCause: 'task_contract_violation',
    runId: workflowExecution.runId,
    taskId: workflowExecution.taskId,
    taskDef: args.taskDef,
    pausedTaskAttempt: workflowExecution.attempt,
    resumePrompt: args.resumePrompt,
    ...(args.expectedTaskOutputSchema
      ? { expectedTaskOutputSchema: args.expectedTaskOutputSchema }
      : {}),
    ...(args.replaceOutputSchema ? { replaceOutputSchema: args.replaceOutputSchema } : {}),
    ...(args.failedOutputPreview !== undefined
      ? { failedOutputPreview: args.failedOutputPreview }
      : {}),
  });

  try {
    const contractRef = await storeWorkflowResumeContract({
      payloadStore: deps.payloadStore,
      tenantId: args.tenantId,
      runId: workflowExecution.runId,
      taskId: workflowExecution.taskId,
      attempt: workflowExecution.attempt,
      contract,
    });
    return { kind: 'paused', contractRef, taskOutputRef: args.taskOutputRef };
  } catch (storeErr) {
    log.warn(
      `[opTaskOutputContract] contract store failed; falling back to failed: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`,
    );
    return {
      kind: 'failed',
      ...(errorRef !== undefined ? { errorRef } : {}),
      failureReason: args.failureMessage,
      errorCode: args.errorCode,
      errorClassification: 'validation',
      errorRetryable: true,
    };
  }
}
