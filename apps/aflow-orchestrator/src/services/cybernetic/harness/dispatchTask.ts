/**
 * Per-task claim-before-spawn dispatch (human, operation, agent).
 */
import { randomUUID } from 'node:crypto';
import { getSessionState, readSpaceContextGen } from '@aflow/redis';
import { claimAndSchedule as ledgerClaimAndSchedule } from '@aflow/cybernetic-runtime';
import type { SessionId, TraceId } from '@aflow/schemas';
import { inferTaskType } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { encodeTaskInput } from '../../../lib/encodeTaskInput.js';
import {
  buildTaskInputRef as ledgerBuildTaskInputRef,
  buildDelegateTaskInput,
} from '../taskHelpers.js';
import {
  isInlineOperation,
  isWorkflowTaskSafeInlineOperation,
} from '../../SessionOrchestrator/helpers/inlineOperations.js';
import { emitTaskUpdate, loadRunByRunIdAcrossSpaces, resolveWorkflowForRun } from './helpers.js';
import { decideFrozenOpTaskDispatch } from '../evalBatch/frozenRunGate.js';
import { dispatchHumanWorkflowTask } from './dispatchHumanTask.js';
import { spawnRunnerSession } from './runnerBridge.js';
import { resolveWorkflowTaskAuthority } from './taskAuthority.js';
import type { DispatchTaskArgs, HarnessDeps } from './types.js';
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

export async function dispatchTask(deps: HarnessDeps, args: DispatchTaskArgs): Promise<void> {
  const { tenantId, runId, taskId, attempt, helmsmanSessionId } = args;
  const tenantIdStr = tenantId as string;
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:dispatchTask',
    runId,
    taskId,
    attempt,
  });

  // 1. Load run + workflow definition (revision-pinned).
  //
  // The three guards below throw rather than log+return — invariant
  // failures (run row missing, workflow definition unresolvable, task
  // not in the workflow's task list) signal a programming or
  // configuration error. Callers like `startRun` collect these into
  // failed-dispatch records and drive `applyFailureMode` so the
  // workflow run reaches a terminal state and the Helmsman waiter
  // wakes up. A silent return would leave no row, no
  // completion_pending, and no failure — Helmsman hangs forever.
  //
  // Distinct from "task already claimed" (returns normally below) —
  // that's a legitimate no-op when concurrent scheduling races.
  const run = await loadRunByRunIdAcrossSpaces(deps.db, tenantIdStr, runId);
  if (!run) {
    log.error(`[dispatchTask] run not found`, undefined, { runId });
    throw new Error(`[dispatchTask] workflow run not found: runId=${runId}`);
  }
  const workflow = await resolveWorkflowForRun(deps.db, tenantIdStr, run);
  if (!workflow) {
    log.error(`[dispatchTask] workflow not resolvable`, undefined, {
      runId,
      slug: run.workflowSlug,
    });
    throw new Error(
      `[dispatchTask] workflow definition not resolvable: runId=${runId} slug=${run.workflowSlug} rev=${String(run.workflowRevision)}`,
    );
  }
  const task = workflow.tasks.find((t) => t.taskId === taskId);
  if (!task) {
    log.error(`[dispatchTask] task not in workflow definition`, undefined, { runId, taskId });
    throw new Error(
      `[dispatchTask] task '${taskId}' not present in workflow ${run.workflowSlug}@rev${String(run.workflowRevision)}`,
    );
  }

  const taskType = inferTaskType(task);

  // 2. Branch on task type.
  if (taskType === 'human') {
    await dispatchHumanWorkflowTask({
      deps,
      tenantId,
      tenantIdStr,
      runId,
      taskId,
      attempt,
      run,
      task,
    });
    return;
  }

  if (taskType === 'operation') {
    // Operation task — workflow-task envelope. No Runner. The executor
    // emits a result with `workflowExecution` set; ResultConsumer routes
    // to onWorkflowTaskComplete.
    const operationId = task.operation;
    if (!operationId) {
      log.error(`[dispatchTask] operation task missing 'operation' field`, undefined, {
        runId,
        taskId,
      });
      // Invariant — operation task with no operation field is a
      // workflow-definition bug. Throw so startRun's failure path
      // marks the task failed and drives the run to terminal.
      throw new Error(
        `[dispatchTask] operation task '${taskId}' missing required 'operation' field`,
      );
    }
    if (isInlineOperation(operationId) && !isWorkflowTaskSafeInlineOperation(operationId)) {
      log.error(
        `[dispatchTask] inline operation '${operationId}' is not workflow-task-safe`,
        undefined,
        { runId, taskId },
      );
      throw new Error(
        `[dispatchTask] inline operation '${operationId}' on task '${taskId}' is not on the workflow-task safelist (its handler does not emit workflowExecution-correlated results). Use a different operation, or add it to WORKFLOW_TASK_SAFE_INLINE_OPERATIONS once the handler is correlation-aware.`,
      );
    }
    // Op tasks bypass step gating entirely, so the trial's read-only
    // grant cannot reach them — refuse a live-tier frozen write here.
    // Throwing pre-claim rides the standard collected-failure path: the
    // task fails, the run terminalizes, the trial is graded.
    const frozenDenial = decideFrozenOpTaskDispatch(run, operationId);
    if (frozenDenial !== null) {
      throw new Error(`[dispatchTask] ${frozenDenial}`);
    }
    const dispatchAttemptToken = `dispatch:${runId}:${taskId}:${String(attempt)}`;
    const workerSessionId = randomUUID();

    const helmsmanState = await getSessionState(deps.redis, tenantIdStr, helmsmanSessionId);
    const taskAuthority = await resolveWorkflowTaskAuthority(
      deps.redis,
      deps.db,
      tenantIdStr,
      helmsmanSessionId,
      helmsmanState,
      workerSessionId,
    );

    // Resolve task input via the existing pure helper. This handles
    // `inputBindings` (run input / upstream task_output / state vars),
    const inputRef = await ledgerBuildTaskInputRef(
      task,
      workflow,
      tenantIdStr,
      run.spaceId,
      runId,
      deps.payloadStore,
    );

    const snoozeDelayMs = await resolveOperationTaskSnoozeDelayMs(
      deps.payloadStore,
      operationId,
      inputRef,
    );

    // Atomic claim — INSERT task row + completion_pending in one TX.
    // For snooze, the `completion_pending` supervision window accounts for
    // the delay (dueAt = now + durationMs + DISPATCH_PENDING_INTERVAL_MS)
    // so the sweeper doesn't reap a healthy snooze mid-wait.
    const claimed = await ledgerClaimAndSchedule(deps.db, tenantIdStr, {
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
      log.info(`[dispatchTask] operation task already claimed; skipping`);
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
      taskType: 'operation',
      startedAt: new Date(),
    }).catch((err: unknown) => {
      logOrchestratorError(
        `[dispatchTask] emit WorkflowTaskUpdate(running) failed (operation): ${err instanceof Error ? err.message : String(err)}`,
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
        ...(taskAuthority.credentialOwnerId !== undefined
          ? { credentialOwnerId: taskAuthority.credentialOwnerId }
          : {}),
        ...(taskAuthority.rootTrigger !== undefined
          ? { rootTrigger: taskAuthority.rootTrigger }
          : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Pass display metadata so the WorkflowTaskUpdate(failed) emitted
      // by postClaimFailure carries the same label/operation as the
      await postClaimFailure(deps, tenantId, runId, taskId, attempt, reason, {
        label: task.name,
        operationId,
        workerSessionId,
      });
      throw new PostClaimDispatchError(taskId, reason);
    }

    log.info(
      `[dispatchTask] ${describeOperationTaskDispatch(dispatchMode, snoozeDelayMs)} operation task: ${operationId}`,
    );
    return;
  }

  // taskType === 'agent' — claim row then spawn Runner session.
  const dispatchAttemptToken = `dispatch:${runId}:${taskId}:${String(attempt)}`;
  const workerSessionId = randomUUID() as SessionId;

  // Read Helmsman session for grant + space context inheritance.
  const helmsmanStateForAgent = await getSessionState(deps.redis, tenantIdStr, helmsmanSessionId);

  // The Runner's `processFlowInput` only handles `{ input, config }` at
  // the top level — so only those become the Runner's input ref (spilled
  // to the payload store when oversized). The delegate input's remaining
  // fields (`context` / `outputSchema` / `displayMeta` / `agentId`) are
  // stamped onto structured fields the QUEUED→RUNNING rebuild already
  // preserves (delegationContextJson, finalOutputSchemaOverrideJson,
  // delegationDisplay*).
  const delegateInput = await buildDelegateTaskInput(
    task,
    workflow,
    tenantIdStr,
    run.spaceId,
    runId,
    helmsmanStateForAgent?.delegationContextJson,
    helmsmanStateForAgent
      ? {
          cached: {
            ...(helmsmanStateForAgent.spaceContextJson !== undefined
              ? { spaceContextJson: helmsmanStateForAgent.spaceContextJson }
              : {}),
            ...(helmsmanStateForAgent.spaceContextBuiltAt !== undefined
              ? { spaceContextBuiltAt: helmsmanStateForAgent.spaceContextBuiltAt }
              : {}),
            ...(helmsmanStateForAgent.spaceContextGen !== undefined
              ? { spaceContextGen: helmsmanStateForAgent.spaceContextGen }
              : {}),
          },
          currentGen: await readSpaceContextGen(deps.redis, tenantIdStr, run.spaceId),
        }
      : undefined,
    deps.payloadStore,
    run.metadata,
  );
  const runnerInputRef = await encodeTaskInput(
    deps.payloadStore,
    { tenantId: tenantIdStr, runId, label: `runner input task=${taskId}` },
    { input: delegateInput.input, config: delegateInput.config },
  );

  const claimed = await ledgerClaimAndSchedule(deps.db, tenantIdStr, {
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
    log.info(`[dispatchTask] agent task already claimed; skipping`);
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
    taskType: 'agent',
    startedAt: new Date(),
  }).catch((err: unknown) => {
    logOrchestratorError(
      `[dispatchTask] emit WorkflowTaskUpdate(running) failed (agent): ${err instanceof Error ? err.message : String(err)}`,
      err,
      { tenantId: tenantIdStr, runId, taskId, attempt },
    );
  });

  try {
    // Spawn the Runner session — uses the pre-allocated workerSessionId.
    // The structured fields below land on the QUEUED Runner state and
    // are preserved through the start_run consumer's RUNNING rebuild.
    const agentVersionPins = (run as { agentVersionPins?: Record<string, string> | null })
      .agentVersionPins;
    const pinnedAgentVersion =
      agentVersionPins !== null && agentVersionPins !== undefined
        ? agentVersionPins[delegateInput.agentId]
        : undefined;

    await spawnRunnerSession(deps, {
      tenantId,
      spaceId: run.spaceId,
      workerSessionId,
      helmsmanSessionId,
      workflowExecution: { runId, taskId, attempt },
      inputRef: runnerInputRef,
      agentDefinitionRef: delegateInput.agentId,
      // The run carries what its batch pinned. A production run pins nothing
      // and resolves `latest` exactly as before.
      ...(pinnedAgentVersion !== undefined ? { agentVersion: pinnedAgentVersion } : {}),
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
    });
    throw new PostClaimDispatchError(taskId, reason);
  }

  log.info(`[dispatchTask] spawned Runner session for agent task: ${taskId}`);
}
