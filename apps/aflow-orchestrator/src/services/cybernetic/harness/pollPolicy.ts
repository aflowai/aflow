import { randomUUID } from 'node:crypto';
import {
  evaluateUntilPredicate,
  advanceTaskPollCycle,
  type WorkflowTaskRow,
  type WorkflowRunDetail,
} from '@aflow/cybernetic-runtime';
import { getSessionState, scheduleShardTimer, type SessionHotState } from '@aflow/redis';
import { POLL_RESERVED_OUTPUT_KEY } from '@aflow/schemas';
import type {
  OperationId,
  SessionId,
  StepExecutionId,
  StepId,
  StepType,
  TenantId,
  TraceId,
  WorkflowTask,
  WorkflowTaskPoll,
} from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import { attendedAsActingRun } from '../../SessionOrchestrator/handlers/inlineOps/actingRun.js';
import { DISPATCH_PENDING_INTERVAL_MS } from './operationTaskDispatch.js';
import type { HarnessDeps, WorkflowExecutionRef, WorkflowTaskOutcome } from './types.js';

// ============================================================================
// Pure decision machine
// ============================================================================

/** The platform-reserved `_poll` stamp written into the task output. */
export interface PollStamp {
  /** Total executions performed (1-based). */
  cycles: number;
  /** True when the task completed because `maxCycles` ran out. */
  exhausted: boolean;
  /** Whether `until` was satisfied at terminal completion. */
  conditionMet: boolean;
}

/**
 * Derive the 1-based poll cycle a result belongs to from its dispatch
 * token. The first dispatch carries the base token
 * `dispatch:<runId>:<taskId>:<attempt>` (cycle 1); re-dispatches append
 * `:poll:<cycle>`. Falls back to the row's current cycle when the token is
 * absent (redrive paths) so the result is treated as the live cycle.
 */
export function parsePollCycleFromToken(token: string | undefined, fallback: number): number {
  if (token === undefined) return fallback;
  const match = /:poll:(\d+)$/.exec(token);
  return match ? Number(match[1]) : 1;
}

export type PollDecision =
  | { kind: 'complete'; stamp: PollStamp }
  | { kind: 'fail'; failureReason: string; errorCode: string }
  | { kind: 'next_cycle'; nextCycle: number };

/**
 * Pure poll-cycle decision: evaluate `until` against the RAW op output.
 * Met → terminal completion. Unmet + cycles left → next cycle. Exhausted →
 * per `onExhausted` ('complete' default: terminal completion with the last
 * raw output + `_poll.exhausted: true`; 'fail': structured failure).
 */
export function decidePollCycle(
  poll: WorkflowTaskPoll,
  resultCycle: number,
  rawOutput: unknown,
): PollDecision {
  if (evaluateUntilPredicate(poll.until, rawOutput)) {
    return {
      kind: 'complete',
      stamp: { cycles: resultCycle, exhausted: false, conditionMet: true },
    };
  }
  if (resultCycle < poll.maxCycles) {
    return { kind: 'next_cycle', nextCycle: resultCycle + 1 };
  }
  if (poll.onExhausted === 'fail') {
    return {
      kind: 'fail',
      failureReason: `Poll budget exhausted: ${String(poll.maxCycles)} cycle(s) completed without the until condition being met.`,
      errorCode: 'POLL_BUDGET_EXHAUSTED',
    };
  }
  return {
    kind: 'complete',
    stamp: { cycles: resultCycle, exhausted: true, conditionMet: false },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Stamp the reserved `_poll` block INTO the task output (not row metadata)
 * — downstream consumption happens through `task_output` bindings, which
 * read outputs only. Non-object raw outputs (op outputs are objects by
 * schema) degrade to a bare `{ _poll }` rather than dropping the stamp.
 */
export function stampPollIntoOutput(rawOutput: unknown, stamp: PollStamp): Record<string, unknown> {
  const base = isRecord(rawOutput) ? rawOutput : {};
  return { ...base, [POLL_RESERVED_OUTPUT_KEY]: stamp };
}

// ============================================================================
// Harness gate (I/O)
// ============================================================================

export type PollGateResult =
  /** Result consumed by the poll loop (stale duplicate or next cycle armed) — caller returns WITHOUT clearing completion_pending. */
  | { kind: 'handled' }
  /** Proceed with this (possibly rewritten) outcome through the normal record path. */
  | { kind: 'proceed'; outcome: WorkflowTaskOutcome };

export interface ApplyPollGateArgs {
  tenantId: TenantId;
  run: WorkflowRunDetail;
  taskRow: WorkflowTaskRow;
  /** Resolved task definition (null when the workflow def is unresolvable). */
  taskDef: WorkflowTask | null;
  workflowExecution: WorkflowExecutionRef;
  outcome: Extract<WorkflowTaskOutcome, { kind: 'succeeded' }>;
  traceId?: TraceId;
}

/**
 * The poll gate `onWorkflowTaskComplete` runs on every first-delivery
 * SUCCEEDED outcome before recording. Non-polled tasks pass straight
 * through. For polled tasks:
 *
 *   - stale cycle (token cycle ≠ row cycle, or CAS miss) → 'handled':
 *     drop WITHOUT clearing completion_pending — the in-flight cycle owns it.
 *   - condition unmet + cycles left → 'handled': CAS-advance `poll_cycle`,
 *     re-arm completion_pending, schedule the workflow-correlated timer for
 *     the next cycle (fresh StepExecution id + `…:poll:<n>` token).
 *   - terminal (met / exhausted-complete) → 'proceed' with the output
 *     rewritten to a NEW payload carrying the `_poll` stamp.
 *   - exhausted with `onExhausted: 'fail'` → 'proceed' with a failed
 *     outcome (`POLL_BUDGET_EXHAUSTED`, non-retryable).
 */
export async function applyPollGate(
  deps: HarnessDeps,
  args: ApplyPollGateArgs,
): Promise<PollGateResult> {
  const { tenantId, run, taskRow, taskDef, workflowExecution, outcome } = args;
  const { runId, taskId, attempt } = workflowExecution;
  const poll = taskDef?.poll;
  if (!poll) return { kind: 'proceed', outcome };

  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:pollGate',
    runId,
    taskId,
    attempt,
  });
  const tenantIdStr = tenantId as string;

  // 1. Which cycle does this result belong to? Duplicate deliveries of an
  //    already-advanced cycle are dropped here (cheap pre-check; the
  //    advanceTaskPollCycle CAS is the authoritative guard).
  const resultCycle = parsePollCycleFromToken(
    workflowExecution.dispatchAttemptToken,
    taskRow.pollCycle,
  );
  if (resultCycle !== taskRow.pollCycle) {
    log.info(
      `[pollGate] stale poll cycle — result.cycle=${String(resultCycle)} row.cycle=${String(taskRow.pollCycle)}; dropping`,
    );
    return { kind: 'handled' };
  }

  // 2. Evaluate `until` against the RAW op output. An unreadable payload
  //    makes the condition unverifiable — end the loop conservatively by
  //    letting the task complete with the raw ref (no stamp) rather than
  //    burning cycles on a result we cannot inspect.
  let rawOutput: unknown;
  try {
    rawOutput = await deps.payloadStore.retrieve(outcome.outputRef);
  } catch (err) {
    log.warn(
      `[pollGate] could not retrieve raw output for until evaluation; completing un-stamped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: 'proceed', outcome };
  }

  const decision = decidePollCycle(poll, resultCycle, rawOutput);

  // 3a. Terminal completion (met or exhausted-complete) — stamp `_poll`
  //     into a NEW task-output payload (the executor's step output stays
  //     raw; never overwrite a payload with different content).
  if (decision.kind === 'complete') {
    let stampedRef = outcome.outputRef;
    try {
      stampedRef = await deps.payloadStore.store({
        tenantId,
        runId: runId as SessionId,
        // Distinct from the executor's step-output ref AND from
        // resume-contract refs (which use bare taskId) — refs are derived
        // from (runId, stepExecutionId, attempt, kind).
        stepExecutionId: `${taskId}:poll` as StepExecutionId,
        attempt,
        kind: 'output',
        data: stampPollIntoOutput(rawOutput, decision.stamp),
      });
    } catch (err) {
      log.warn(
        `[pollGate] failed to store _poll-stamped output; completing with raw ref: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    log.info(
      `[pollGate] poll terminal after ${String(decision.stamp.cycles)} cycle(s) (conditionMet=${String(decision.stamp.conditionMet)}, exhausted=${String(decision.stamp.exhausted)})`,
    );
    return { kind: 'proceed', outcome: { kind: 'succeeded', outputRef: stampedRef } };
  }

  // 3b. Exhausted with onExhausted: 'fail' — surface through the normal
  //     failure path (applyFailureMode). Not retryable: the budget is the
  //     author's declared ceiling, not a transient fault.
  if (decision.kind === 'fail') {
    log.info(`[pollGate] poll budget exhausted with onExhausted='fail'`);
    return {
      kind: 'proceed',
      outcome: {
        kind: 'failed',
        failureReason: decision.failureReason,
        errorCode: decision.errorCode,
        errorRetryable: false,
      },
    };
  }

  // 3c. Next cycle. CAS-advance the row (dedupes duplicate deliveries),
  //     re-arm completion_pending, then arm the workflow-correlated timer.
  const nextCycle = decision.nextCycle;
  const operationId = taskRow.operationId ?? taskDef.operation;
  const inputRef = taskRow.inputRef;
  if (!operationId || !inputRef) {
    // Invariant break — an operation task always has both from claim time.
    log.error(
      `[pollGate] cannot re-dispatch poll cycle: missing ${!operationId ? 'operationId' : 'inputRef'} on task row`,
      undefined,
      { runId, taskId, attempt },
    );
    return {
      kind: 'proceed',
      outcome: {
        kind: 'failed',
        failureReason: `Poll re-dispatch failed: task row is missing its ${!operationId ? 'operation id' : 'input ref'}.`,
        errorCode: 'POLL_REDISPATCH_FAILED',
        errorRetryable: false,
      },
    };
  }

  const nextStepExecutionId = randomUUID();
  const advanced = await advanceTaskPollCycle(deps.db, tenantIdStr, {
    runId,
    taskId,
    attempt,
    fromCycle: resultCycle,
    toCycle: nextCycle,
    stepExecutionId: nextStepExecutionId,
    dueAt: new Date(Date.now() + poll.intervalMs + DISPATCH_PENDING_INTERVAL_MS),
  });
  if (!advanced) {
    log.info(`[pollGate] poll-cycle CAS miss (concurrent path owns the row); dropping`);
    return { kind: 'handled' };
  }

  // Credential owner for BYOK resolution — recovered best-effort from the
  // originating Helmsman session (mirrors dispatchTask). Hot state may have
  // expired on long runs; the timer then dispatches without it.
  let credentialOwnerId: string | undefined;
  let helmsmanState: SessionHotState | null = null;
  if (run.sessionId) {
    try {
      helmsmanState = await getSessionState(deps.redis, tenantIdStr, run.sessionId);
      credentialOwnerId = helmsmanState?.createdBy;
    } catch {
      credentialOwnerId = undefined;
    }
  }

  const nextToken = `dispatch:${runId}:${taskId}:${String(attempt)}:poll:${String(nextCycle)}`;
  try {
    await scheduleShardTimer(deps.redis, {
      tenantId,
      workflowExecution: { runId, taskId, attempt, dispatchAttemptToken: nextToken },
      stepExecutionId: nextStepExecutionId as StepExecutionId,
      stepId: taskId as StepId,
      operationId: operationId as OperationId,
      stepType: operationId.split('.')[0] as StepType,
      reason: 'delayed_start',
      attempt,
      inputRef,
      traceId: args.traceId ?? (randomUUID() as TraceId),
      dueAtMs: Date.now() + poll.intervalMs,
      spaceId: run.spaceId,
      ...(credentialOwnerId !== undefined ? { credentialOwnerId } : {}),
      activatedByPerson: attendedAsActingRun(helmsmanState),
    });
  } catch (err) {
    // Timer arm failed AFTER the CAS — the re-armed completion_pending row
    // is the safety net: the sweeper bumps and eventually escalates the
    // attempt, so the run can't strand silently.
    log.error(
      `[pollGate] failed to schedule poll-cycle timer (sweeper will reap): ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
      { runId, taskId, attempt, nextCycle },
    );
  }

  log.info(
    `[pollGate] until unmet — armed poll cycle ${String(nextCycle)}/${String(poll.maxCycles)} (+${String(poll.intervalMs)}ms)`,
  );
  return { kind: 'handled' };
}
