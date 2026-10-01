/**
 * Waiter notification — wake Helmsman observers on run transitions.
 */
import { randomUUID } from 'node:crypto';
import {
  appendSessionEvent,
  getStepState,
  markSessionDirty,
  updateSessionState,
  updateStepState,
  addStepResult,
} from '@aflow/redis';
import {
  buildWorkflowRunDetail,
  loadPendingWaiters,
  loadWorkflowTaskByWorkerSession,
  markWaiterNotified,
  rehydrateParkedStep,
  surfaceWorkflowResumeContract,
} from '@aflow/cybernetic-runtime';
import type {
  SessionId,
  StepExecutionId,
  StepId,
  StepType,
  OperationId,
  TraceId,
  IdempotencyKey,
  PayloadRef,
  WorkflowRunDetailOutput,
  WorkflowRunResult,
  WorkflowRunWakeupEnvelope,
  WorkflowRunWakeupHumanDecision,
  WorkflowRunWakeupPauseContext,
} from '@aflow/schemas';
import type { SessionEvent } from '@aflow/redis';
import { buildWakeupCancellation } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { emitTerminalRunUpdate, loadRunByRunIdAcrossSpaces } from './helpers.js';
import { deliverSessionWakeup } from './sessionWakeup.js';
import type { HarnessDeps, NotifyWaitersArgs } from './types.js';

export type { NotifyWaitersArgs } from './types.js';

/**
 * For each pending waiter row, write a synthetic StepResultMessage that
 * wakes the waiter's parked step — or, for a session that started the run
 * without waiting, append a `WorkflowRunWakeup` event to its conversation.
 * Idempotency keys are keyed on the waiter
 * row id (not the session id) so multiple pause cycles in the same
 * session each get unique keys.
 */
export async function notifyWaiters(deps: HarnessDeps, args: NotifyWaitersArgs): Promise<void> {
  const tenantIdStr = args.tenantId as string;
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:notifyWaiters',
    runId: args.runId,
  });

  const allWaiters = await loadPendingWaiters(deps.db, tenantIdStr, args.runId);
  if (allWaiters.length === 0) {
    log.debug(`[notifyWaiters] no pending waiters for run=${args.runId}`);
    return;
  }

  const excludeSet = new Set(args.excludeSessionIds ?? []);
  const waiters = allWaiters.filter((w) => !excludeSet.has(w.waiterSessionId));
  if (waiters.length === 0) {
    log.debug(
      `[notifyWaiters] all ${String(allWaiters.length)} waiter(s) excluded for run=${args.runId}`,
    );
    return;
  }

  log.info(
    `[notifyWaiters] notifying ${String(waiters.length)} of ${String(allWaiters.length)} waiter(s) outcome=${args.outcome} run=${args.runId}`,
  );

  // On a TERMINAL transition, build the run-detail DTO ONCE and reuse it
  // for everything this notification carries: the operator's resolved
  const terminalDetail =
    args.outcome === 'completed' || args.outcome === 'failed' || args.outcome === 'cancelled'
      ? await loadTerminalRunDetail(deps, args)
      : null;
  const runResult = terminalDetail?.result;

  await emitTerminalRunUpdate(deps, args, runResult).catch((err: unknown) => {
    // Best-effort: surface events should never block the run-resume
    // path. Log and continue.
    logOrchestratorError(
      `[notifyWaiters] emit WorkflowRunUpdate failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
      { tenantId: tenantIdStr, runId: args.runId, outcome: args.outcome },
    );
  });

  const humanDecisions = terminalDetail ? extractHumanDecisions(terminalDetail) : undefined;

  for (const waiter of waiters) {
    try {
      if (waiter.waiterStepExecutionId === null) {
        // Its delivery records itself: a session waiter hears every pause and
        // is retired only by the outcome that ends the run.
        await wakeSessionWaiter(deps, args, waiter, humanDecisions, runResult);
        continue;
      }
      const parentTask = await loadWorkflowTaskByWorkerSession(
        deps.db,
        tenantIdStr,
        waiter.waiterStepExecutionId,
      );
      if (parentTask !== null) {
        // A takeover leaves the task waiting for the run to end. A pause ends
        // its wait instead: nobody hears a pause inside a task, so the run
        // would sit paused and the task claimed for good.
        if (args.outcome !== 'paused' && !isRunEnding(args.outcome)) continue;
        await answerWorkflowTask(
          deps,
          args,
          { id: waiter.id, waiterStepExecutionId: waiter.waiterStepExecutionId },
          parentTask,
          humanDecisions,
          runResult,
        );
        await markWaiterNotified(deps.db, tenantIdStr, {
          waiterId: waiter.id,
          outcome: args.outcome,
        });
        if (args.outcome === 'paused') {
          await cancelPausedChild(deps, args, parentTask);
        }
        continue;
      }
      await wakeWaiter(
        deps,
        args,
        {
          id: waiter.id,
          waiterSessionId: waiter.waiterSessionId,
          waiterStepExecutionId: waiter.waiterStepExecutionId,
        },
        humanDecisions,
        runResult,
      );
      await markWaiterNotified(deps.db, tenantIdStr, {
        waiterId: waiter.id,
        outcome: args.outcome,
      });
    } catch (err) {
      // Best-effort per-waiter — failure to notify one shouldn't stop the others.
      logOrchestratorError(
        `[notifyWaiters] failed for waiter=${waiter.id} session=${waiter.waiterSessionId}: ${err instanceof Error ? err.message : String(err)}`,
        err,
        {
          tenantId: tenantIdStr,
          runId: args.runId,
          waiterId: waiter.id,
          sessionId: waiter.waiterSessionId,
          outcome: args.outcome,
        },
      );
    }
  }
}

function isRunEnding(outcome: NotifyWaitersArgs['outcome']): boolean {
  return outcome === 'completed' || outcome === 'failed' || outcome === 'cancelled';
}

/**
 * The task was answered with the pause, so the run it started has nobody left
 * to resume it. Its waiter is already notified, so the cancellation answers no
 * one a second time.
 */
async function cancelPausedChild(
  deps: HarnessDeps,
  args: NotifyWaitersArgs,
  task: { runId: string; taskId: string },
): Promise<void> {
  try {
    const { cancelRun } = await import('./cancel.js');
    await cancelRun(deps, args.tenantId, args.runId, {
      cancelledBy: 'system',
      reason: `Paused inside task "${task.taskId}" of run ${task.runId}, which cannot wait on a pause; the task went on without its result.`,
    });
  } catch (err) {
    logOrchestratorError(
      `[notifyWaiters] could not cancel run=${args.runId} after it paused under task=${task.taskId} of run=${task.runId}: ${err instanceof Error ? err.message : String(err)}`,
      err,
      { tenantId: args.tenantId as string, runId: args.runId, parentRunId: task.runId },
    );
  }
}

/**
 * Complete the workflow task that started this run, with the wakeup envelope
 * as its output, through the same result path an executor's answer takes.
 *
 * The run's promoted output travels only when it completed: a task gates on
 * what the child produced, and a child that failed, was cancelled or paused
 * produced nothing a gate may treat as its answer, whatever it promoted on the
 * way.
 */
async function answerWorkflowTask(
  deps: HarnessDeps,
  args: NotifyWaitersArgs,
  waiter: { id: string; waiterStepExecutionId: string },
  task: { runId: string; taskId: string; attempt: number; dispatchAttemptToken: string | null },
  humanDecisions: readonly WorkflowRunWakeupHumanDecision[] | undefined,
  runResult: WorkflowRunResult | undefined,
): Promise<void> {
  if (task.dispatchAttemptToken === null) {
    throw new Error(
      `task ${task.taskId} of run ${task.runId} carries no dispatch token, so no claim of it can be answered`,
    );
  }
  const outputRef = await buildWaiterOutputRef(
    deps,
    args,
    waiter,
    humanDecisions,
    args.outcome === 'completed' ? runResult : undefined,
  );
  await addStepResult(deps.redis, {
    messageVersion: 1,
    tenantId: args.tenantId,
    workflowExecution: {
      runId: task.runId,
      taskId: task.taskId,
      attempt: task.attempt,
      dispatchAttemptToken: task.dispatchAttemptToken,
    },
    stepExecutionId: waiter.waiterStepExecutionId as StepExecutionId,
    parentStepExecutionId: null,
    stepId: task.taskId as StepId,
    stepType: 'workflow' as StepType,
    operationId: 'workflow.run.start' as OperationId,
    attempt: task.attempt,
    idempotencyKey: `notify-waiter:${waiter.id}:${args.outcome}` as IdempotencyKey,
    status: 'SUCCEEDED',
    outputRef,
    durationMs: 0,
    traceId: `notify-waiter:${waiter.id}` as TraceId,
    finishedAtMs: Date.now(),
  });
}

async function wakeSessionWaiter(
  deps: HarnessDeps,
  args: NotifyWaitersArgs,
  waiter: { id: string; waiterSessionId: string },
  humanDecisions: readonly WorkflowRunWakeupHumanDecision[] | undefined,
  runResult: WorkflowRunResult | undefined,
): Promise<void> {
  await deliverSessionWakeup(deps, {
    tenantId: args.tenantId,
    sessionId: waiter.waiterSessionId,
    runId: args.runId,
    waiterId: waiter.id,
    report:
      args.outcome === 'paused'
        ? { outcome: 'paused', pauseVersion: args.pauseVersion }
        : { outcome: args.outcome },
    storeEnvelope: (eventId) =>
      buildWaiterOutputRef(deps, args, waiter, humanDecisions, runResult, {
        payloadSlot: eventId,
      }),
  });
}

async function wakeWaiter(
  deps: HarnessDeps,
  args: NotifyWaitersArgs,
  waiter: { id: string; waiterSessionId: string; waiterStepExecutionId: string },
  humanDecisions: readonly WorkflowRunWakeupHumanDecision[] | undefined,
  runResult: WorkflowRunResult | undefined,
): Promise<void> {
  const waiterStepExecutionId = waiter.waiterStepExecutionId;

  let stepState = await getStepState(deps.redis, args.tenantId, waiterStepExecutionId);
  if (!stepState) {
    // The waiter parked longer than the hot-state TTL — the normal shape for a
    // run that pauses on a human task, since the parked session takes no
    // writes to refresh it and an operator's approval is not on a clock. Cold
    // is not gone: the snapshot flushed at the park carries this exact step.
    // Giving up here strands the parent forever, because the waiter row is
    // stamped notified on return and no later transition reconsiders it.
    const rehydrated = await rehydrateParkedStep(
      deps.redis,
      deps.db,
      args.tenantId as string,
      waiter.waiterSessionId,
      waiterStepExecutionId,
    );
    if (rehydrated) {
      stepState = await getStepState(deps.redis, args.tenantId, waiterStepExecutionId);
    }
  }
  if (!stepState) {
    // Unrecoverable — the session is durably gone, or its snapshot never
    // carried this step. Nothing a retry reaches, so the caller may stamp the
    // waiter; loud, because a parent left parked is invisible from the run.
    logOrchestratorError(
      `[notifyWaiters] waiter=${waiter.id} session=${waiter.waiterSessionId} has no step state and could not be rehydrated — the parked caller cannot be woken`,
      new Error('waiter step state unrecoverable'),
      {
        tenantId: args.tenantId as string,
        runId: args.runId,
        waiterId: waiter.id,
        sessionId: waiter.waiterSessionId,
        stepExecutionId: waiterStepExecutionId,
        outcome: args.outcome,
      },
    );
    return;
  }

  // If a child workflow run is CANCELLED, do not auto-resume the waiting parent.
  // Instead, set `interruptRequested` so applyStepSucceeded records the tool
  // result and then pauses the session, requiring explicit user input to
  // continue (prevents autonomous re-entry after cancellations).

  const cancelled = args.outcome === 'cancelled';

  // Reset step from PAUSED → STARTED so the synthetic result transitions
  // it to SUCCEEDED cleanly.
  if (stepState.status === 'PAUSED') {
    await updateStepState(deps.redis, args.tenantId, waiterStepExecutionId, {
      sessionId: waiter.waiterSessionId,
      status: 'STARTED',
    });
  }

  if (!cancelled) {
    // Append a SessionResumed event (observability for SSE consumers). Skipped
    // for cancelled — the session pauses, it does not resume; applyStepSucceeded
    // emits SessionPaused.
    const resumeEvent: SessionEvent = {
      eventId: randomUUID(),
      eventType: 'SessionResumed',
      timestamp: Date.now(),
      sessionId: waiter.waiterSessionId,
      metadata: {
        runId: args.runId,
        waiterId: waiter.id,
        outcome: args.outcome,
        ...(args.handoffPayload ? { handoffPayload: args.handoffPayload } : {}),
      },
    };
    await appendSessionEvent(
      deps.redis,
      args.tenantId,
      waiter.waiterSessionId as SessionId,
      resumeEvent,
    );
  }
  await updateSessionState(deps.redis, args.tenantId, waiter.waiterSessionId, {
    waitingOnWorkflowRunId: undefined,
    ...(cancelled ? { interruptRequested: true } : {}),
  });
  await markSessionDirty(deps.redis, args.tenantId, waiter.waiterSessionId as SessionId);

  // Synthesize a result that wakes the waiter's step. The waiter's step
  // is `workflow.run.start` (or .resume). Status SUCCEEDED so the
  // calling Helmsman's flow continues to its next step. The output is a
  // small wakeup envelope describing the outcome — Helmsman renders it
  // for the user.
  //
  // Idempotency key is keyed on waiter row id, NOT session id — multiple
  // pause cycles in the same session each get unique keys.
  const idempotencyKey = `notify-waiter:${waiter.id}:${args.outcome}` as IdempotencyKey;

  const outputRef = await buildWaiterOutputRef(deps, args, waiter, humanDecisions, runResult);

  // TraceIdSchema requires .min(1) — an empty string fails parse and the
  // synthetic result silently drops, leaving the waiter asleep. Prefer
  // the waiter session's recorded trace id; fall back to a deterministic
  // per-waiter identifier so observability is still attributable.
  const traceId =
    stepState.traceId !== undefined && stepState.traceId.length > 0
      ? (stepState.traceId as TraceId)
      : (`notify-waiter:${waiter.id}` as TraceId);

  await addStepResult(deps.redis, {
    messageVersion: 1,
    tenantId: args.tenantId,
    sessionId: waiter.waiterSessionId as SessionId,
    stepExecutionId: waiterStepExecutionId as StepExecutionId,
    parentStepExecutionId: null,
    stepId: stepState.stepId as StepId,
    stepType: stepState.stepType as StepType,
    operationId: stepState.operationId as OperationId,
    attempt: stepState.attempt,
    idempotencyKey,
    status: 'SUCCEEDED',
    outputRef,
    resolvedInputRef: stepState.inputRef,
    durationMs: 0,
    traceId,
    finishedAtMs: Date.now(),
  });
}

/**
 * Build the `outputRef` payload for a waiter wakeup. Small envelope
 * describing the outcome — keeps the synthetic result self-contained
 * without forcing callers to ship a payloadRef explicitly.
 *
 * When `outcome === 'paused'`
 * and a contract payload ref is available, dereference it and inline
 * the parsed pause context (taskId, cause, reason) into the envelope.
 * The alternative — a prompt rule telling Helmsman to call
 * `workflow.run.detail` after every wake to discover which task paused
 * and why — is a fragile harness-driven concern expressed as prompt
 * prose. The harness
 * just gives Helmsman the answer in its tool result, and the LLM's
 * natural narration uses the right taskId without a follow-up call.
 * payloadRef is still in the envelope, so callers that need the full
 * structured contract (resolution mode, schema, etc.) can resolve it.
 */
async function buildWaiterOutputRef(
  deps: HarnessDeps,
  args: NotifyWaitersArgs,
  waiter: { id: string },
  humanDecisions: readonly WorkflowRunWakeupHumanDecision[] | undefined,
  runResult: WorkflowRunResult | undefined,
  options: { payloadSlot?: string } = {},
): Promise<PayloadRef> {
  // Typed against the published contract (`WorkflowRunWakeupEnvelopeSchema`,
  // runStart.ts) so the envelope Helmsman reads can't drift from the schema.
  const envelope: WorkflowRunWakeupEnvelope = {
    runId: args.runId,
    outcome: args.outcome,
    waiterId: waiter.id,
    // Structured "what did this run produce" block — promoted output
    // values, primary score vs target, deterministic outcome checks,
    // closing summary, artifact pointer, and declared caller guidance.
    // Helmsman reads the deliverable straight from this tool result
    // instead of a follow-up `workflow.run.detail`.
    ...(runResult ? { result: runResult } : {}),
    ...(args.payloadRef !== undefined ? { payloadRef: args.payloadRef } : {}),
    ...(args.handoffPayload ? { handoffPayload: args.handoffPayload } : {}),
    ...(humanDecisions && humanDecisions.length > 0 ? { humanDecisions: [...humanDecisions] } : {}),
    // Operator-cancel legibility — the cancellation block carries the actor
    // AND the retry affordance (`retryPolicy`) in the envelope value itself,
    // so an operator's deliberate stop is never mistaken for a transient
    // platform failure the agent should auto-retry.
    ...(args.outcome === 'cancelled' && args.cancellation
      ? { cancellation: buildWakeupCancellation(args.cancellation) }
      : {}),
  };

  if (args.outcome === 'paused' && args.payloadRef !== undefined) {
    const pauseContext = await extractPauseContext(
      deps,
      args.tenantId,
      args.runId,
      args.payloadRef,
    );
    if (pauseContext) envelope.pause = pauseContext;
  }

  return deps.payloadStore.store({
    tenantId: args.tenantId,
    runId: args.runId as unknown as SessionId,
    stepExecutionId: (options.payloadSlot ?? waiter.id) as StepExecutionId,
    attempt: 1,
    kind: 'output',
    data: envelope,
  });
}

async function extractPauseContext(
  deps: HarnessDeps,
  tenantId: string,
  runId: string,
  payloadRef: string,
): Promise<WorkflowRunWakeupPauseContext | null> {
  try {
    const data = await deps.payloadStore.retrieve(payloadRef);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const contract = data as Record<string, unknown>;

    const ctx: WorkflowRunWakeupPauseContext = {};
    if (typeof contract['failedTaskId'] === 'string') {
      ctx.taskId = contract['failedTaskId'];
    }
    if (typeof contract['pauseCause'] === 'string') {
      ctx.pauseCause = contract['pauseCause'];
    }

    // Walk a small priority list for the most-descriptive reason field.
    const handoff = contract['handoffPayload'];
    const handoffReason =
      handoff && typeof handoff === 'object' && !Array.isArray(handoff)
        ? (handoff as Record<string, unknown>)['reason']
        : undefined;
    const reason =
      (typeof handoffReason === 'string' ? handoffReason : undefined) ??
      (typeof contract['decisionPrompt'] === 'string' ? contract['decisionPrompt'] : undefined) ??
      (typeof contract['errorMessage'] === 'string' ? contract['errorMessage'] : undefined) ??
      (typeof contract['resumePrompt'] === 'string' ? contract['resumePrompt'] : undefined);
    if (typeof reason === 'string') ctx.reason = reason;

    try {
      const surfaced = await surfaceWorkflowResumeContract(
        deps.db,
        deps.payloadStore,
        tenantId,
        runId,
      );
      if (surfaced) {
        if (surfaced.contract.allowedResumeModes) {
          ctx.allowedResumeModes = surfaced.contract.allowedResumeModes;
        }
        if (surfaced.contract.suggestedResumeCall) {
          ctx.suggestedResumeCall = { ...surfaced.contract.suggestedResumeCall };
        }
        if (surfaced.contract.pausedTaskInputContract) {
          ctx.pausedTaskInputContract = { ...surfaced.contract.pausedTaskInputContract };
        }
      }
    } catch {
      // Surface helper failure → omit inlined contract keys. Helmsman
      // falls back to `workflow.run.detail` for the structured shape.
    }

    // The harness decides the next step from the pause cause so the agent
    // doesn't re-derive it from prompt prose. A human-approval pause is the
    // operator's to resolve on the run surface — forwarding suggestedResumeCall
    // would steal the decision; every other known cause makes the agent the
    // resumer. Keyed on pauseCause, not on whether suggestedResumeCall was
    // inlined: if surfacing the contract failed above, the agent is still the
    // resumer and fetches the call via workflow.run.detail.
    if (ctx.pauseCause === 'needs_decision') {
      ctx.nextStep = 'operator_resolves_on_run_surface';
    } else if (ctx.pauseCause) {
      ctx.nextStep = 'fire_suggested_resume_call';
    }

    return Object.keys(ctx).length > 0 ? ctx : null;
  } catch {
    // Best-effort: a missing or malformed contract must not block the
    // wake. Helmsman still gets outcome + payloadRef.
    return null;
  }
}

async function loadTerminalRunDetail(
  deps: HarnessDeps,
  args: NotifyWaitersArgs,
): Promise<WorkflowRunDetailOutput | null> {
  try {
    const spaceId =
      args.runDetail?.spaceId ??
      (await loadRunByRunIdAcrossSpaces(deps.db, args.tenantId as string, args.runId))?.spaceId;
    if (!spaceId) return null;
    return await buildWorkflowRunDetail(
      deps.db,
      deps.payloadStore,
      args.tenantId as string,
      spaceId,
      args.runId,
    );
  } catch {
    return null;
  }
}

function extractHumanDecisions(
  detail: WorkflowRunDetailOutput,
): WorkflowRunWakeupHumanDecision[] | undefined {
  const decisions: WorkflowRunWakeupHumanDecision[] = [];
  for (const t of detail.tasks) {
    if (t.humanDecision) {
      decisions.push({ taskId: t.taskId, label: t.label, ...t.humanDecision });
    }
  }
  return decisions.length > 0 ? decisions : undefined;
}
