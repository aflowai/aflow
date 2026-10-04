/**
 * Periodic sweeper for stale workflow run completion-pending rows.
 */
import {
  executorWaitHasLooksLeft,
  getSessionState,
  getShardTimer,
  getStepInFlight,
} from '@aflow/redis';
import {
  getTaskRow,
  casCompleteTask as ledgerCasCompleteTask,
  listDueCompletionPending,
  bumpCompletionPendingDueAt,
  clearCompletionPending,
  addCompletionPending,
  recoverOrphanedTaskAttempt,
  loadParkedStepWaitersForSession,
  loadWorkflowTaskByWorkerSession,
} from '@aflow/cybernetic-runtime';
import type { TenantId } from '@aflow/schemas';
import type { SessionId, StepExecutionId } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { dispatchNextOrTerminate } from './dispatch.js';
import { applyFailureMode } from './pauseResume.js';
import { routeRunnerTerminalToHarness } from './runnerBridge.js';
import type {
  HarnessDeps,
  ReconcileStaleRunResult,
  RunnerTerminalKind,
  RunnerTerminalPayloads,
} from './types.js';

export type { ReconcileStaleRunResult } from './types.js';

const SWEEPER_DEFAULT_BATCH = 100;
const SWEEPER_RUNNING_BUMP_MS = 60_000;
const SWEEPER_ERROR_BUMP_MS = 30_000;
const SWEEPER_OPERATION_ESCALATION_BUMPS = 30;
const RUNNER_TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'PAUSED', 'CANCELLED']);

async function waitsOnARun(
  deps: HarnessDeps,
  tenantId: string,
  workerSessionId: string | null,
): Promise<boolean> {
  if (workerSessionId === null) return false;
  const waiting = await loadParkedStepWaitersForSession(deps.db, tenantId, workerSessionId);
  return waiting.length > 0;
}

/**
 * A task parked on its missing executor is answered by its `executor_wait`
 * timer — dispatched when a look finds the executor, failed once its looks are
 * spent — which a sleeping machine can stretch past any bump budget. The wait
 * is recognised as a session step's is: by a live timer with looks left.
 */
async function waitsOnItsExecutor(
  deps: HarnessDeps,
  tenantId: string,
  row: { attempt: number; workerSessionId: string },
): Promise<boolean> {
  const task = await loadWorkflowTaskByWorkerSession(deps.db, tenantId, row.workerSessionId);
  if (task?.dispatchAttemptToken == null || task.attempt !== row.attempt) return false;
  const timer = await getShardTimer(deps.redis, {
    workflowExecution: {
      runId: task.runId,
      taskId: task.taskId,
      attempt: task.attempt,
      dispatchAttemptToken: task.dispatchAttemptToken,
    },
    stepExecutionId: row.workerSessionId as StepExecutionId,
    reason: 'executor_wait',
    attempt: row.attempt,
  });
  return timer?.executorWait !== undefined && executorWaitHasLooksLeft(timer.executorWait);
}

export async function reconcileStaleRunForTenant(
  deps: HarnessDeps,
  tenantId: TenantId,
  opts: { limit?: number; now?: Date } = {},
): Promise<ReconcileStaleRunResult> {
  const tenantIdStr = tenantId as string;
  const limit = opts.limit ?? SWEEPER_DEFAULT_BATCH;
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:reconcileStaleRun',
    tenantId: tenantIdStr,
  });
  const result: ReconcileStaleRunResult = {
    scanned: 0,
    orphans: 0,
    redrives: 0,
    bumps: 0,
    operationBumps: 0,
    zombies: 0,
    escalations: 0,
    errors: 0,
  };

  const dueOpts = opts.now ? { limit, now: opts.now } : { limit };
  const due = await listDueCompletionPending(deps.db, tenantIdStr, dueOpts);
  result.scanned = due.length;
  if (due.length === 0) return result;

  for (const row of due) {
    try {
      const currentRow = await getTaskRow(deps.db, tenantIdStr, row.runId, row.taskId);
      // A row the run has already moved past is as stale as a missing one — the
      // pending marker belongs to an attempt nothing will complete any more.
      const taskRow = currentRow?.attempt === row.attempt ? currentRow : null;

      if (!taskRow) {
        try {
          await dispatchNextOrTerminate(deps, tenantId, row.runId);
        } catch (dispatchErr) {
          log.warn(
            `[reconcileStaleRun] zombie redispatch failed for run=${row.runId} ` +
              `task=${row.taskId}: ${dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr)} ` +
              `— bumping pending row dueAt; next sweeper tick retries`,
          );
          // Bump dueAt so we don't spin on this row immediately, then
          // continue. The pending row is preserved as the retry marker.
          await bumpCompletionPendingDueAt(deps.db, tenantIdStr, {
            runId: row.runId,
            taskId: row.taskId,
            attempt: row.attempt,
            newDueAt: new Date(Date.now() + SWEEPER_ERROR_BUMP_MS),
            lastError: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
          });
          result.zombies += 1;
          continue;
        }
        // Redispatch landed (or short-circuited cleanly). Clear the
        // zombie pending row so future sweeper passes don't pick it up.
        await clearCompletionPending(deps.db, tenantIdStr, {
          runId: row.runId,
          taskId: row.taskId,
          attempt: row.attempt,
        });
        result.zombies += 1;
        continue;
      }

      const isAgentTask = taskRow.sessionId != null;

      if (!isAgentTask) {
        // Operation task: executor-backed, no SessionHotState. Default
        // behaviour is to bump due_at; executor jobs are managed by the
        // executor runtime's own retry/timeout loop.
        //
        // The bump count alone is a flat clock, and a harness review runs
        // longer than any flat clock chosen for a file read. The executor
        // refreshes an in-flight record with its own deadline while it
        // works, so a step it still holds is not stalled, however many
        // bumps it has taken.
        const inFlight =
          row.workerSessionId != null
            ? await getStepInFlight(deps.redis, row.workerSessionId)
            : { alive: false, deadlineAtMs: null };
        const executorStillOnIt =
          inFlight.alive && (inFlight.deadlineAtMs === null || inFlight.deadlineAtMs > Date.now());
        // A task that started a run is answered when that run ends, which a
        // review can take longer than any bump budget to do. Its pending waiter
        // is what says it is still waiting rather than lost.
        if (
          row.attemptCount >= SWEEPER_OPERATION_ESCALATION_BUMPS &&
          !executorStillOnIt &&
          !(await waitsOnARun(deps, tenantIdStr, row.workerSessionId)) &&
          !(await waitsOnItsExecutor(deps, tenantIdStr, row))
        ) {
          log.warn(
            `[reconcileStaleRun] escalating stalled operation task to failed: ` +
              `run=${row.runId} task=${row.taskId} attempt=${String(row.attempt)} ` +
              `bumpCount=${String(row.attemptCount)} (threshold=${String(SWEEPER_OPERATION_ESCALATION_BUMPS)})`,
          );
          const reason =
            `Operation task stalled — no executor result after ` +
            `${String(row.attemptCount)} sweeper bumps. Likely cause: addStepJob ` +
            `never durably enqueued (orchestrator crashed mid-claim), or executor ` +
            `lost the job. Marking failed so the run can advance.`;
          const escalatedAt = new Date();
          const landed = await ledgerCasCompleteTask(deps.db, tenantIdStr, {
            runId: row.runId,
            taskId: row.taskId,
            attempt: row.attempt,
            status: 'failed',
            failureReason: reason,
            completedAt: escalatedAt,
            failedAt: escalatedAt,
          });
          await clearCompletionPending(deps.db, tenantIdStr, {
            runId: row.runId,
            taskId: row.taskId,
            attempt: row.attempt,
          });
          if (landed) {
            // Drive the run forward via the workflow's failure policy
            // (cancel_siblings / continue_optional / fail_run).
            await applyFailureMode(deps, tenantId, row.runId, row.taskId);
          }
          result.escalations += 1;
          continue;
        }

        await bumpCompletionPendingDueAt(deps.db, tenantIdStr, {
          runId: row.runId,
          taskId: row.taskId,
          attempt: row.attempt,
          newDueAt: new Date(Date.now() + SWEEPER_RUNNING_BUMP_MS),
        });
        result.operationBumps += 1;
        continue;
      }

      const sessionState = await getSessionState(
        deps.redis,
        tenantId,
        row.workerSessionId as SessionId,
      );

      // Branch 1: hot state missing — orphan rescue.
      if (!sessionState) {
        const recovered = await recoverOrphanedTaskAttempt(
          deps.db,
          tenantIdStr,
          row.runId,
          row.taskId,
          row.attempt,
        );
        if (recovered) {
          result.orphans += 1;
          log.info(
            `[reconcileStaleRun] recovered orphan: run=${row.runId} task=${row.taskId} ` +
              `attempt=${String(row.attempt)} workerSession=${row.workerSessionId}`,
          );
          try {
            await dispatchNextOrTerminate(deps, tenantId, row.runId);
          } catch (dispatchErr) {
            log.warn(
              `[reconcileStaleRun] orphan-redispatch failed for run=${row.runId} ` +
                `task=${row.taskId}: ${dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr)} ` +
                `— re-inserting pending row so the next sweeper tick retries`,
            );
            await addCompletionPending(deps.db, tenantIdStr, {
              runId: row.runId,
              taskId: row.taskId,
              attempt: row.attempt,
              workerSessionId: row.workerSessionId,
              dueAt: new Date(Date.now() + SWEEPER_RUNNING_BUMP_MS),
            });
          }
        } else {
          // Row already moved on (concurrent recovery, late terminal). Bump
          // due_at so we don't spin on the same row this tick.
          await bumpCompletionPendingDueAt(deps.db, tenantIdStr, {
            runId: row.runId,
            taskId: row.taskId,
            attempt: row.attempt,
            newDueAt: new Date(Date.now() + SWEEPER_RUNNING_BUMP_MS),
          });
          result.bumps += 1;
        }
        continue;
      }

      // Branch 2: hot state in a terminal status — re-drive intercept.
      if (RUNNER_TERMINAL_STATUSES.has(sessionState.status)) {
        const kind: RunnerTerminalKind =
          sessionState.status === 'SUCCEEDED'
            ? 'SUCCEEDED'
            : sessionState.status === 'PAUSED'
              ? 'PAUSED'
              : 'FAILED'; // FAILED + CANCELLED both route as failed-task outcomes
        const payloads: RunnerTerminalPayloads = {
          ...(sessionState.finalOutputRef ? { outputRef: sessionState.finalOutputRef } : {}),
          ...(sessionState.errorRef ? { errorRef: sessionState.errorRef } : {}),
        };
        // PAUSED carries the resume contract on `requestedInputRef`.
        if (kind === 'PAUSED' && sessionState.requestedInputRef) {
          payloads.contractRef = sessionState.requestedInputRef;
        }

        // SUCCEEDED requires outputRef; if it's somehow missing, treat
        // as orphan rather than throwing — the row is in a degenerate
        // state and the orphan path lets the next scheduling pass retry.
        //
        if (kind === 'SUCCEEDED' && !payloads.outputRef) {
          log.warn(
            `[reconcileStaleRun] SUCCEEDED Runner has no finalOutputRef — treating as orphan ` +
              `run=${row.runId} task=${row.taskId} workerSession=${row.workerSessionId}`,
          );
          const recovered = await recoverOrphanedTaskAttempt(
            deps.db,
            tenantIdStr,
            row.runId,
            row.taskId,
            row.attempt,
          );
          if (recovered) {
            try {
              await dispatchNextOrTerminate(deps, tenantId, row.runId);
            } catch (dispatchErr) {
              log.warn(
                `[reconcileStaleRun] degraded-orphan redispatch failed for run=${row.runId} ` +
                  `task=${row.taskId}: ${dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr)} ` +
                  `— re-inserting pending row so the next sweeper tick retries`,
              );
              await addCompletionPending(deps.db, tenantIdStr, {
                runId: row.runId,
                taskId: row.taskId,
                attempt: row.attempt,
                workerSessionId: row.workerSessionId,
                dueAt: new Date(Date.now() + SWEEPER_RUNNING_BUMP_MS),
              });
            }
          }
          result.orphans += 1;
          continue;
        }

        await routeRunnerTerminalToHarness(
          deps,
          {
            workflowExecution: {
              runId: row.runId,
              taskId: row.taskId,
              attempt: row.attempt,
            },
            tenantId: tenantIdStr,
            ...(sessionState.traceId ? { traceId: sessionState.traceId } : {}),
          },
          kind,
          payloads,
        );
        result.redrives += 1;
        continue;
      }

      // Branch 3: still working — bump due_at.
      await bumpCompletionPendingDueAt(deps.db, tenantIdStr, {
        runId: row.runId,
        taskId: row.taskId,
        attempt: row.attempt,
        newDueAt: new Date(Date.now() + SWEEPER_RUNNING_BUMP_MS),
      });
      result.bumps += 1;
    } catch (err) {
      // Bump due_at with the error so the next pass retries; a permanently
      // failing row will eventually be picked up by an operator looking at
      // `last_error`. Without this, a single bad row would block the whole
      // sweeper batch on every tick.
      logOrchestratorError(
        `[reconcileStaleRun] entry failed: run=${row.runId} task=${row.taskId} ` +
          `attempt=${String(row.attempt)}`,
        err,
        {
          tenantId: tenantIdStr,
          runId: row.runId,
          taskId: row.taskId,
          attempt: row.attempt,
        },
      );
      try {
        await bumpCompletionPendingDueAt(deps.db, tenantIdStr, {
          runId: row.runId,
          taskId: row.taskId,
          attempt: row.attempt,
          newDueAt: new Date(Date.now() + SWEEPER_ERROR_BUMP_MS),
          lastError: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // Best-effort — even if the bump fails, the loop continues to
        // the next row. The errored row will be re-examined in the
        // next tick at the same dueAt.
      }
      result.errors += 1;
    }
  }

  log.debug(
    `[reconcileStaleRun] tenant=${tenantIdStr} scanned=${String(result.scanned)} ` +
      `orphans=${String(result.orphans)} redrives=${String(result.redrives)} ` +
      `bumps=${String(result.bumps)} operationBumps=${String(result.operationBumps)} ` +
      `zombies=${String(result.zombies)} escalations=${String(result.escalations)} ` +
      `errors=${String(result.errors)}`,
  );
  return result;
}
