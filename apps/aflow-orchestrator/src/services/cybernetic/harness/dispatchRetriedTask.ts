import { randomUUID } from 'node:crypto';
import { getSessionState, readSpaceContextGen } from '@aflow/redis';
import { claimRetriedTask as ledgerClaimRetriedTask } from '@aflow/cybernetic-runtime';
import type { SessionId, TraceId } from '@aflow/schemas';
import { inferTaskType } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { encodeTaskInput } from '../../../lib/encodeTaskInput.js';
import {
  buildTaskInputRef as ledgerBuildTaskInputRef,
  buildDelegateTaskInput,
} from '../taskHelpers.js';
import { emitTaskUpdate, loadRunByRunIdAcrossSpaces, resolveWorkflowForRun } from './helpers.js';
import { decideFrozenOpTaskDispatch } from '../evalBatch/frozenRunGate.js';
import { spawnRunnerSession } from './runnerBridge.js';
import { resolveWorkflowTaskAuthority } from './taskAuthority.js';
import type { DispatchRetriedTaskArgs, HarnessDeps } from './types.js';
import { PostClaimDispatchError } from './types.js';
import { postClaimFailure } from './dispatchShared.js';
import {
  DISPATCH_PENDING_INTERVAL_MS,
  dispatchClaimedOperationTask,
  operationTaskClaimDueAt,
  describeOperationTaskDispatch,
  resolveOperationTaskSnoozeDelayMs,
  type OperationTaskDispatchMode,
} from './operationTaskDispatch.js';

export async function dispatchRetriedTask(
  deps: HarnessDeps,
  args: DispatchRetriedTaskArgs,
): Promise<void> {
  const { tenantId, runId, taskId, attempt, helmsmanSessionId, systemFeedback } = args;
  const tenantIdStr = tenantId as string;
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:dispatchRetriedTask',
    runId,
    taskId,
    attempt,
  });

  const run = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
  if (!run) {
    throw new Error(`[dispatchRetriedTask] workflow run not found: runId=${runId}`);
  }
  const workflow = await resolveWorkflowForRun(deps.db, tenantIdStr, run);
  if (!workflow) {
    throw new Error(
      `[dispatchRetriedTask] workflow definition not resolvable: runId=${runId} slug=${run.workflowSlug} rev=${String(run.workflowRevision)}`,
    );
  }
  const task = workflow.tasks.find((t) => t.taskId === taskId);
  if (!task) {
    throw new Error(
      `[dispatchRetriedTask] task '${taskId}' not present in workflow ${run.workflowSlug}@rev${String(run.workflowRevision)}`,
    );
  }

  const taskType = inferTaskType(task);
  if (taskType === 'human') {
    // No retry path for human tasks — their failure is operator-driven
    // and resolves via the paused-resume flow.
    throw new Error(
      `[dispatchRetriedTask] task '${taskId}' is a human task; retry_failed_task only supports agent / operation tasks.`,
    );
  }

  const dispatchAttemptToken = `dispatch-retry:${runId}:${taskId}:${String(attempt)}`;
  const workerSessionId = randomUUID() as SessionId;
  const helmsmanState = await getSessionState(deps.redis, tenantIdStr, helmsmanSessionId);
  const taskAuthority = await resolveWorkflowTaskAuthority(
    deps.redis,
    deps.db,
    tenantIdStr,
    helmsmanSessionId,
    helmsmanState,
    workerSessionId,
  );
  const credentialOwnerId = taskAuthority.credentialOwnerId;
  const retriedTaskRow = run.tasks.find((t) => t.taskId === taskId);
  const priorFailures = retriedTaskRow?.priorFailures;

  if (taskType === 'operation') {
    const operationId = task.operation;
    if (!operationId) {
      throw new Error(
        `[dispatchRetriedTask] operation task '${taskId}' missing required 'operation' field`,
      );
    }
    const frozenDenial = decideFrozenOpTaskDispatch(run, operationId);
    if (frozenDenial !== null) {
      throw new Error(`[dispatchRetriedTask] ${frozenDenial}`);
    }
    const inputRef = await ledgerBuildTaskInputRef(
      task,
      workflow,
      tenantIdStr,
      run.spaceId,
      runId,
      deps.payloadStore,
      systemFeedback,
    );

    const snoozeDelayMs = await resolveOperationTaskSnoozeDelayMs(
      deps.payloadStore,
      operationId,
      inputRef,
    );

    const claimed = await ledgerClaimRetriedTask(deps.db, tenantIdStr, {
      runId,
      taskId,
      attempt,
      workerSessionId,
      dispatchAttemptToken,
      inputRef,
      stepExecutionId: workerSessionId,
      operationId,
      dueAt: operationTaskClaimDueAt(snoozeDelayMs),
    });
    if (!claimed) {
      log.info(
        `[dispatchRetriedTask] operation row not in retry-claimable state (already claimed or attempt drift); skipping`,
      );
      return;
    }
    await emitTaskUpdate(deps, {
      tenantId,
      runId,
      taskId,
      label: task.name,
      status: 'running',
      attempt,
      workerSessionId,
      operationId,
      startedAt: new Date(),
    }).catch((err: unknown) => {
      logOrchestratorError(
        `[dispatchRetriedTask] emit WorkflowTaskUpdate(running) failed (operation): ${err instanceof Error ? err.message : String(err)}`,
        err,
        { tenantId: tenantIdStr, runId, taskId, attempt },
      );
    });

    const traceId = randomUUID() as TraceId;
    let dispatchMode: OperationTaskDispatchMode;
    try {
      dispatchMode = await dispatchClaimedOperationTask(deps, {
        tenantId,
        runId,
        taskId,
        attempt,
        dispatchAttemptToken,
        operationId,
        workerSessionId,
        inputRef,
        traceId,
        spaceId: run.spaceId,
        snoozeDelayMs,
        ...(credentialOwnerId !== undefined ? { credentialOwnerId } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await postClaimFailure(deps, tenantId, runId, taskId, attempt, reason, {
        label: task.name,
        operationId,
        workerSessionId,
        startedAt: new Date(),
      });
      throw new PostClaimDispatchError(taskId, reason);
    }
    log.info(
      `[dispatchRetriedTask] ${describeOperationTaskDispatch(dispatchMode, snoozeDelayMs)} retried operation task: ${operationId}`,
    );
    return;
  }

  // agent task
  const delegateInput = await buildDelegateTaskInput(
    task,
    workflow,
    tenantIdStr,
    run.spaceId,
    runId,
    helmsmanState?.delegationContextJson,
    helmsmanState
      ? {
          cached: {
            ...(helmsmanState.spaceContextJson !== undefined
              ? { spaceContextJson: helmsmanState.spaceContextJson }
              : {}),
            ...(helmsmanState.spaceContextBuiltAt !== undefined
              ? { spaceContextBuiltAt: helmsmanState.spaceContextBuiltAt }
              : {}),
            ...(helmsmanState.spaceContextGen !== undefined
              ? { spaceContextGen: helmsmanState.spaceContextGen }
              : {}),
          },
          currentGen: await readSpaceContextGen(deps.redis, tenantIdStr, run.spaceId),
        }
      : undefined,
    deps.payloadStore,
    run.metadata,
    priorFailures,
    systemFeedback,
  );
  const runnerInputRef = await encodeTaskInput(
    deps.payloadStore,
    { tenantId: tenantIdStr, runId, label: `runner input task=${taskId}` },
    { input: delegateInput.input, config: delegateInput.config },
  );
  const claimed = await ledgerClaimRetriedTask(deps.db, tenantIdStr, {
    runId,
    taskId,
    attempt,
    workerSessionId,
    dispatchAttemptToken,
    inputRef: runnerInputRef,
    sessionId: workerSessionId,
    operationId: 'ai.agent.turn',
    dueAt: new Date(Date.now() + DISPATCH_PENDING_INTERVAL_MS),
  });
  if (!claimed) {
    log.info(
      `[dispatchRetriedTask] agent row not in retry-claimable state (already claimed or attempt drift); skipping`,
    );
    return;
  }
  await emitTaskUpdate(deps, {
    tenantId,
    runId,
    taskId,
    label: task.name,
    status: 'running',
    attempt,
    workerSessionId,
    operationId: 'ai.agent.turn',
    startedAt: new Date(),
  }).catch((err: unknown) => {
    logOrchestratorError(
      `[dispatchRetriedTask] emit WorkflowTaskUpdate(running) failed (agent): ${err instanceof Error ? err.message : String(err)}`,
      err,
      { tenantId: tenantIdStr, runId, taskId, attempt },
    );
  });

  try {
    await spawnRunnerSession(deps, {
      tenantId,
      spaceId: run.spaceId,
      workerSessionId,
      helmsmanSessionId,
      workflowExecution: { runId, taskId, attempt },
      inputRef: runnerInputRef,
      agentDefinitionRef: delegateInput.agentId,
      traceId: randomUUID() as TraceId,
      ...(delegateInput.context !== undefined
        ? { delegationContextJson: JSON.stringify(delegateInput.context) }
        : {}),
      ...(delegateInput.outputSchema !== undefined
        ? { finalOutputSchemaOverrideJson: JSON.stringify(delegateInput.outputSchema) }
        : {}),
      ...(delegateInput.validatorRefs !== undefined
        ? { finalOutputValidatorRefs: delegateInput.validatorRefs }
        : {}),
      delegationDisplayWorkflowSlug: delegateInput.displayMeta.workflowSlug,
      delegationDisplayTaskId: delegateInput.displayMeta.taskId,
      delegationDisplayTaskName: delegateInput.displayMeta.taskName,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await postClaimFailure(deps, tenantId, runId, taskId, attempt, reason, {
      label: task.name,
      operationId: 'ai.agent.turn',
      workerSessionId,
      startedAt: new Date(),
    });
    throw new PostClaimDispatchError(taskId, reason);
  }
}
