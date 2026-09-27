import type { TenantId } from '@aflow/schemas';
import {
  buildResumeContract,
  deriveEffectiveOutputSchema,
  DeriveSchemaError,
  storeWorkflowResumeContract,
  runRegisteredOutputValidators,
  formatOutputValidatorIssues,
} from '@aflow/cybernetic-runtime';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import {
  validateAgentOutput,
  annotateWithConsumers,
} from '../../SessionOrchestrator/handlers/inlineOps/agentOutputValidator.js';
import { loadRunByRunIdAcrossSpaces, resolveWorkflowForRun } from './helpers.js';
import type { HarnessDeps, WorkflowExecutionRef, WorkflowTaskOutcome } from './types.js';

export interface ValidateRunnerOutputArgs {
  deps: HarnessDeps;
  tenantId: string;
  workflowExecution: WorkflowExecutionRef;
  outputRef: string;
}

/**
 * Validate a Runner-terminal SUCCEEDED outcome against the task's effective
 * output schema. Returns either the original succeeded outcome (validation
 * passed, schema absent, or infra failure → fail-open) or a converted
 * failed outcome (validation failed → fail-closed).
 *
 * Never throws — all error paths are absorbed into log lines + pass-through
 * to preserve the harness's existing fault tolerance. The submit-time
 * check in `runnerOutput.ts` is the primary enforcement path.
 */
export async function validateRunnerOutputContractAtHarness(
  args: ValidateRunnerOutputArgs,
): Promise<WorkflowTaskOutcome> {
  const { deps, tenantId, workflowExecution, outputRef } = args;
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness',
    op: 'validateRunnerOutputContract',
    runId: workflowExecution.runId,
    taskId: workflowExecution.taskId,
  });

  const succeeded: WorkflowTaskOutcome = { kind: 'succeeded', outputRef };

  // Load the run + workflow to find the task definition.
  let run;
  try {
    run = await loadRunByRunIdAcrossSpaces(deps.db, tenantId, workflowExecution.runId);
  } catch (err) {
    log.warn(
      `[wfRunnerOutputContract] loadRunByRunIdAcrossSpaces failed; passing through: ${err instanceof Error ? err.message : String(err)}`,
    );
    return succeeded;
  }
  if (!run) {
    log.warn(`[wfRunnerOutputContract] run not found; passing through`);
    return succeeded;
  }

  let workflow;
  try {
    workflow = await resolveWorkflowForRun(deps.db, tenantId, run);
  } catch (err) {
    log.warn(
      `[wfRunnerOutputContract] resolveWorkflowForRun failed; passing through: ${err instanceof Error ? err.message : String(err)}`,
    );
    return succeeded;
  }
  if (!workflow) {
    log.warn(`[wfRunnerOutputContract] workflow definition not found; passing through`);
    return succeeded;
  }

  const task = workflow.tasks.find((t) => t.taskId === workflowExecution.taskId);
  if (!task) {
    log.warn(
      `[wfRunnerOutputContract] task=${workflowExecution.taskId} not found in workflow; passing through`,
    );
    return succeeded;
  }

  // Resolve the effective schema: static + derivedFrom.
  const staticSchema = task.outputContract?.schema;
  const derivedFrom = task.outputContract?.derivedFrom;
  let effectiveSchema: Record<string, unknown> | undefined;
  if (derivedFrom && derivedFrom.length > 0) {
    try {
      const derived = await deriveEffectiveOutputSchema({
        tenantId: tenantId as TenantId,
        spaceId: run.spaceId,
        runId: workflowExecution.runId,
        task: {
          taskId: task.taskId,
          outputContract: {
            ...(staticSchema != null ? { schema: staticSchema } : {}),
            derivedFrom,
          },
        },
        db: deps.db,
        payloadStore: deps.payloadStore,
      });
      effectiveSchema = derived.effectiveSchema;
    } catch (err) {
      if (err instanceof DeriveSchemaError) {
        log.warn(
          `[wfRunnerOutputContract] derivedFrom failed for task=${task.taskId} (${err.code}): ${err.message} — passing through`,
        );
      } else {
        log.warn(
          `[wfRunnerOutputContract] derive threw: ${err instanceof Error ? err.message : String(err)} — passing through`,
        );
      }
      return succeeded;
    }
  } else {
    effectiveSchema = staticSchema;
  }

  if (!effectiveSchema) {
    // No contract authored → no enforcement (parity with today).
    return succeeded;
  }

  // Retrieve the output payload.
  let output: unknown;
  try {
    output = await deps.payloadStore.retrieve(outputRef as never);
  } catch (err) {
    log.warn(
      `[wfRunnerOutputContract] payloadStore.retrieve failed; passing through: ${err instanceof Error ? err.message : String(err)}`,
    );
    return succeeded;
  }

  // Run the validator.
  let validation;
  try {
    validation = validateAgentOutput(output, effectiveSchema);
  } catch (err) {
    // P2 fix — schema compile failure is a configuration bug. The
    // `submit_output` path emits `OUTPUT_SCHEMA_INVALID` at submit time;
    // this defense-in-depth path mirrors that strictness by converting
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      `[wfRunnerOutputContract] schema compile threw for task=${task.taskId}: ${msg} — converting to failed(OUTPUT_SCHEMA_INVALID)`,
    );
    const schemaFailureMessage = `The task's outputContract.schema is malformed and could not be compiled: ${msg}.`;
    const schemaErrorRef = await tryStoreErrorPayload(deps, log, {
      tenantId,
      workflowExecution,
      data: {
        code: 'OUTPUT_SCHEMA_INVALID',
        message: schemaFailureMessage,
        classification: 'configuration' as const,
        retryable: false,
        producerTaskId: task.taskId,
        attemptedOutputRef: outputRef,
      },
    });
    return {
      kind: 'failed',
      ...(schemaErrorRef ? { errorRef: schemaErrorRef } : {}),
      failureReason: schemaFailureMessage,
      errorCode: 'OUTPUT_SCHEMA_INVALID',
      errorClassification: 'configuration',
      errorRetryable: false,
    };
  }

  // Determine the failure lines from either the Ajv check or the registered
  // validatorRefs (defense-in-depth parity with the submit-time path). Ajv
  // failure wins; otherwise run the refs against the Ajv-accepted output.
  let lines: string[];
  let actualDesc: string;
  let formatted: string[];
  if (!validation.ok) {
    lines = annotateWithConsumers(validation.rawErrors, workflow, task.taskId).slice(0, 10);
    actualDesc = validation.actualDesc;
    formatted = validation.formatted;
  } else {
    const validatorRefs = task.outputContract?.validatorRefs;
    if (!validatorRefs || validatorRefs.length === 0) return succeeded;
    let refIssues;
    try {
      refIssues = await runRegisteredOutputValidators(validatorRefs, output, {
        tenantId,
        spaceId: run.spaceId,
        runId: workflowExecution.runId,
        db: deps.db,
      });
    } catch (err) {
      log.warn(
        `[wfRunnerOutputContract] validatorRefs threw for task=${task.taskId}; passing through: ${err instanceof Error ? err.message : String(err)}`,
      );
      return succeeded;
    }
    if (refIssues.length === 0) return succeeded;
    lines = formatOutputValidatorIssues(refIssues).slice(0, 10);
    actualDesc = '';
    formatted = lines;
  }

  // Validation FAILED — convert to a failed outcome with consumer-aware
  const failureMessage = `Output contract violation: ${lines.join('; ')}.${actualDesc ? ` ${actualDesc}.` : ''}`;

  // Persist a structured error payload so retry visibility is consistent
  // with executor-side AflowError surfacing. P3 fix — `kind: 'error'`
  // matches the payload-kind discipline (this ref is assigned to
  // `errorRef`, not `outputRef`); using `output` would put it under the
  // wrong GCS prefix for large payloads. `attemptedOutputRef` preserves
  // the Runner's submission for a forensic UI.
  const errorRef = await tryStoreErrorPayload(deps, log, {
    tenantId,
    workflowExecution,
    data: {
      code: 'OUTPUT_CONTRACT_VIOLATION',
      message: failureMessage,
      classification: 'validation' as const,
      retryable: true,
      producerTaskId: task.taskId,
      attemptedOutputRef: outputRef,
      formatted,
      actualDesc,
    },
  });

  log.info(
    `[wfRunnerOutputContract] task=${task.taskId} validation FAILED; pausing for task_contract_violation: ${lines.join('; ')}`,
  );

  const resumePrompt =
    `Task "${task.taskId}" output failed its declared output contract. ` +
    `${lines.join('; ')}.${actualDesc ? ` ${actualDesc}.` : ''} ` +
    'Fix the output via replace_output or retry via re_execute.';
  const contract = buildResumeContract({
    pauseCause: 'task_contract_violation',
    runId: workflowExecution.runId,
    taskId: task.taskId,
    taskDef: task,
    pausedTaskAttempt: workflowExecution.attempt,
    resumePrompt,
    expectedTaskOutputSchema: effectiveSchema,
    replaceOutputSchema: effectiveSchema,
    failedOutputPreview: output,
  });

  try {
    const contractRef = await storeWorkflowResumeContract({
      payloadStore: deps.payloadStore,
      tenantId,
      runId: workflowExecution.runId,
      taskId: task.taskId,
      attempt: workflowExecution.attempt,
      contract,
    });
    return { kind: 'paused', contractRef, taskOutputRef: outputRef };
  } catch (storeErr) {
    log.warn(
      `[wfRunnerOutputContract] contract store failed; falling back to failed: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`,
    );
    return {
      kind: 'failed',
      ...(errorRef ? { errorRef } : {}),
      failureReason: failureMessage,
      errorCode: 'OUTPUT_CONTRACT_VIOLATION',
      errorClassification: 'validation',
      errorRetryable: true,
    };
  }
}

async function tryStoreErrorPayload(
  deps: HarnessDeps,
  log: ReturnType<typeof getOrchestratorLogger>['child'] extends (...a: never[]) => infer R
    ? R
    : never,
  args: {
    tenantId: string;
    workflowExecution: WorkflowExecutionRef;
    data: Record<string, unknown>;
  },
): Promise<string | undefined> {
  try {
    return await deps.payloadStore.store({
      tenantId: args.tenantId as never,
      runId: args.workflowExecution.runId as never,
      stepExecutionId: args.workflowExecution.taskId as never,
      attempt: args.workflowExecution.attempt,
      kind: 'error',
      data: args.data,
    });
  } catch (storeErr) {
    log.warn(
      `[wfRunnerOutputContract] failed to persist error payload; outcome carries no errorRef: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`,
    );
    return undefined;
  }
}
