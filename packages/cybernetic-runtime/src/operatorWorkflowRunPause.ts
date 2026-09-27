import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import type {
  IdempotencyKey,
  SessionId,
  TenantId,
  TraceId,
  WorkflowRunPauseInput,
  WorkflowRunPauseOutput,
  WorkflowRunPauseReason,
  WorkflowTask,
} from '@aflow/schemas';
import { addControlMessage, markStepCancelled, publishStepAbort } from '@aflow/redis';
import { resolveWorkflowForRunRevision } from '@aflow/database';
import {
  loadRunById,
  pauseRunningRunByOperator,
  addAttentionItem,
  interruptRunningTaskToPaused,
  clearAllCompletionPendingForRun,
  type WorkflowRunDetail,
} from './ledger.js';
import { buildResumeContract, surfaceWorkflowResumeContract } from './workflowResume.js';
import { storeWorkflowResumeContract } from './pauseContractStorage.js';
import { emitWorkflowProgress } from './workflowRunProgress.js';
import { getCyberneticLogger } from './logger.js';

export interface OperatorWorkflowRunPauseDeps {
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore: PayloadStore;
}

export type OperatorWorkflowRunPauseResult =
  { ok: true; output: WorkflowRunPauseOutput } | { ok: false; code: string; message: string };

export async function executeOperatorWorkflowRunPause(
  deps: OperatorWorkflowRunPauseDeps,
  args: {
    tenantId: TenantId;
    spaceId: string;
    userId: string;
    input: WorkflowRunPauseInput;
  },
): Promise<OperatorWorkflowRunPauseResult> {
  const log = getCyberneticLogger();
  const tenantIdStr = args.tenantId as string;
  const { runId } = args.input;
  const reason = args.input.reason?.trim() || 'Operator paused the run.';

  const run = await loadRunById(deps.db, tenantIdStr, args.spaceId, runId);
  if (!run) {
    return {
      ok: false,
      code: 'WORKFLOW_RUN_NOT_FOUND',
      message: `No workflow run "${runId}" in this space.`,
    };
  }

  // Already paused (any cause) — never re-stamp; surface the live state so
  // the operator UI shows Resume against the existing pause.
  if (run.status === 'paused') {
    return {
      ok: true,
      output: {
        runId,
        status: 'paused',
        pauseVersion: run.pauseVersion,
        pauseCause: await resolvePauseCause(deps, tenantIdStr, runId),
        alreadyPaused: true,
      },
    };
  }
  if (run.status !== 'running') {
    return {
      ok: false,
      code: 'RUN_NOT_RUNNING',
      message: `Run "${runId}" is ${run.status}; only a running run can be paused.`,
    };
  }

  const target = await resolveInterruptTarget(deps, tenantIdStr, args.spaceId, run);
  if (target) {
    return interruptRestartPause(deps, args, run, target, reason);
  }

  // 1+2. Build + store the manual resume contract before the CAS.
  const contract = buildResumeContract({ pauseCause: 'manual', runId, reason });
  const contractRef = await storeWorkflowResumeContract({
    payloadStore: deps.payloadStore,
    tenantId: tenantIdStr,
    runId,
    // Run-level pause has no task; runId is a stable payload-addressing key.
    taskId: runId,
    attempt: 1,
    contract,
  });

  // 3. CAS running → paused.
  const cas = await pauseRunningRunByOperator(deps.db, tenantIdStr, runId, {
    reason: 'manual',
    payloadRef: contractRef,
  });
  if (!cas.paused) {
    // Lost the race against a concurrent pause/terminate between load and CAS.
    const after = await loadRunById(deps.db, tenantIdStr, args.spaceId, runId);
    if (after?.status === 'paused') {
      return {
        ok: true,
        output: {
          runId,
          status: 'paused',
          pauseVersion: after.pauseVersion,
          pauseCause: await resolvePauseCause(deps, tenantIdStr, runId),
          alreadyPaused: true,
        },
      };
    }
    return {
      ok: false,
      code: 'RUN_NOT_RUNNING',
      message: `Run "${runId}" is no longer running.`,
    };
  }

  // 4. Run-level attention item (no taskId).
  try {
    await addAttentionItem(deps.db, tenantIdStr, {
      kind: 'workflow_run_paused',
      spaceId: args.spaceId,
      relatedRunId: runId,
      payload: { pauseCause: 'manual', reason, pausedByUserId: args.userId },
      priority: 0,
    });
  } catch (err) {
    log.warn(
      `[executeOperatorWorkflowRunPause] attention write failed (non-fatal) run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 5. Emit a live paused run-update so the surface flips to Resume without a
  //    refetch. notifyWaiters is intentionally NOT called — this only updates
  //    the observation channel; the parked Helmsman step stays asleep.
  try {
    await emitWorkflowProgress(
      { db: deps.db, redis: deps.redis },
      {
        tenantId: tenantIdStr,
        runId,
        event: {
          kind: 'WorkflowRunUpdate',
          payload: {
            runId,
            slug: run.workflowSlug,
            status: 'paused',
            pauseVersion: cas.pauseVersion,
            pausedReason: 'manual',
            startedAt: (run.startedAt ?? new Date()).toISOString(),
          },
        },
      },
    );
  } catch (err) {
    log.warn(
      `[executeOperatorWorkflowRunPause] WorkflowRunUpdate(paused) emit failed (non-fatal) run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    ok: true,
    output: {
      runId,
      status: 'paused',
      pauseVersion: cas.pauseVersion,
      pauseCause: 'manual',
      alreadyPaused: false,
    },
  };
}

/** Best-effort read of the live contract's pauseCause for the response. */
async function resolvePauseCause(
  deps: OperatorWorkflowRunPauseDeps,
  tenantId: string,
  runId: string,
): Promise<WorkflowRunPauseReason> {
  const surfaced = await surfaceWorkflowResumeContract(deps.db, deps.payloadStore, tenantId, runId);
  return surfaced?.contract.pauseCause ?? 'manual';
}

interface InterruptTarget {
  taskId: string;
  attempt: number;
  workerSessionId: string;
  taskDef: WorkflowTask | null;
  label: string;
}

async function resolveInterruptTarget(
  deps: OperatorWorkflowRunPauseDeps,
  tenantId: string,
  spaceId: string,
  run: WorkflowRunDetail,
): Promise<InterruptTarget | null> {
  const inflight = run.tasks.filter((t) => t.status === 'running' && t.workerSessionId != null);
  if (inflight.length !== 1) return null;
  const t = inflight[0]!;
  let taskDef: WorkflowTask | null = null;
  try {
    const resolved = await resolveWorkflowForRunRevision(
      deps.db,
      tenantId as TenantId,
      spaceId,
      run.workflowSlug,
      run.workflowRevision,
    );
    taskDef = resolved.workflow.tasks.find((d) => d.taskId === t.taskId) ?? null;
  } catch {
    // Unresolvable definition ⇒ treat as unknown retryability ⇒ soft-quiesce.
    return null;
  }
  // Default `unknown` is the conservative non-safe bucket — only an explicit
  // `safe` declaration unlocks interrupt-restart.
  if ((taskDef?.retryability ?? 'unknown') !== 'safe') return null;
  return {
    taskId: t.taskId,
    attempt: t.attempt,
    workerSessionId: t.workerSessionId!,
    taskDef,
    label: taskDef?.name ?? t.taskId,
  };
}

async function interruptRestartPause(
  deps: OperatorWorkflowRunPauseDeps,
  args: { tenantId: TenantId; spaceId: string; userId: string; input: WorkflowRunPauseInput },
  run: WorkflowRunDetail,
  target: InterruptTarget,
  reason: string,
): Promise<OperatorWorkflowRunPauseResult> {
  const log = getCyberneticLogger();
  const tenantIdStr = args.tenantId as string;
  const runId = run.runId;

  // 1+2. Build + store a TASK-backed manual contract (allows re_execute with
  //      optional guidance — `safe` tasks bypass the remediationConfirmed gate).
  //      `interruptRestart` forces re_execute even when the failure-retry budget
  //      is spent (the default `maxAttempts:1` would otherwise make a first-
  //      attempt safe task advertise only `['fail']` — un-resumable from the UI,
  //      which has no fail action). The operator deliberately interrupted; this
  //      is a human override, not an automated retry.
  const contract = buildResumeContract({
    pauseCause: 'manual',
    runId,
    reason,
    taskId: target.taskId,
    taskDef: target.taskDef,
    pausedTaskAttempt: target.attempt,
    interruptRestart: true,
  });
  const contractRef = await storeWorkflowResumeContract({
    payloadStore: deps.payloadStore,
    tenantId: tenantIdStr,
    runId,
    taskId: target.taskId,
    attempt: target.attempt,
    contract,
  });

  // 3. CAS run running → paused with the ref (same primitive as soft-quiesce).
  const cas = await pauseRunningRunByOperator(deps.db, tenantIdStr, runId, {
    reason: 'manual',
    payloadRef: contractRef,
  });
  if (!cas.paused) {
    const after = await loadRunById(deps.db, tenantIdStr, args.spaceId, runId);
    if (after?.status === 'paused') {
      return {
        ok: true,
        output: {
          runId,
          status: 'paused',
          pauseVersion: after.pauseVersion,
          pauseCause: await resolvePauseCause(deps, tenantIdStr, runId),
          alreadyPaused: true,
        },
      };
    }
    return { ok: false, code: 'RUN_NOT_RUNNING', message: `Run "${runId}" is no longer running.` };
  }

  // 4. CAS the in-flight task running → paused. If it lost the race (the task
  //    just finished), the run is still paused — leave the task; the re_execute
  //    resume falls back to acknowledge.
  const taskCas = await interruptRunningTaskToPaused(deps.db, tenantIdStr, runId, target.taskId);
  if (taskCas.paused && taskCas.workerSessionId) {
    // 4a. Kill the Runner. Best-effort: a missed cancel just means the Runner
    //     runs a bit longer; its late result is dropped (task no longer running).
    //     An OPERATION task has no Runner session — its `workerSessionId` is the
    //     step execution id — so the session-addressed control message below can
    //     never reach it. The step abort does, and is inert for an agent task.
    await markStepCancelled(deps.redis, taskCas.workerSessionId, taskCas.attempt, 'interrupted');
    publishStepAbort(deps.redis, taskCas.workerSessionId, 'interrupted');
    try {
      await addControlMessage(deps.redis, {
        messageVersion: 1,
        type: 'cancel_run',
        tenantId: args.tenantId,
        runId: taskCas.workerSessionId as SessionId,
        traceId: randomUUID() as TraceId,
        idempotencyKey: `workflow-interrupt:${runId}:${taskCas.workerSessionId}` as IdempotencyKey,
        requestedAtMs: Date.now(),
      });
    } catch (err) {
      log.warn(
        `[interruptRestartPause] cancel_run cascade failed (non-fatal) run=${runId} session=${taskCas.workerSessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // 4b. Drop the killed Runner's completion-pending so its late result can't
    //     resurrect the task. Single in-flight task ⇒ clearing all is correct.
    try {
      await clearAllCompletionPendingForRun(deps.db, tenantIdStr, runId);
    } catch (err) {
      log.warn(
        `[interruptRestartPause] clear completion_pending failed (non-fatal) run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // 4c. Emit the task→paused update so the live card reflects the interrupt.
    try {
      await emitWorkflowProgress(
        { db: deps.db, redis: deps.redis },
        {
          tenantId: tenantIdStr,
          runId,
          event: {
            kind: 'WorkflowTaskUpdate',
            payload: {
              runId,
              taskId: target.taskId,
              label: target.label,
              status: 'paused',
              attempt: target.attempt,
            },
          },
        },
      );
    } catch (err) {
      log.warn(
        `[interruptRestartPause] WorkflowTaskUpdate(paused) emit failed (non-fatal) run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 5. Run-level attention + live run-update (same as soft-quiesce).
  try {
    await addAttentionItem(deps.db, tenantIdStr, {
      kind: 'workflow_run_paused',
      spaceId: args.spaceId,
      relatedRunId: runId,
      payload: {
        pauseCause: 'manual',
        reason,
        pausedByUserId: args.userId,
        interruptedTaskId: target.taskId,
      },
      priority: 0,
    });
  } catch (err) {
    log.warn(
      `[interruptRestartPause] attention write failed (non-fatal) run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    await emitWorkflowProgress(
      { db: deps.db, redis: deps.redis },
      {
        tenantId: tenantIdStr,
        runId,
        event: {
          kind: 'WorkflowRunUpdate',
          payload: {
            runId,
            slug: run.workflowSlug,
            status: 'paused',
            pauseVersion: cas.pauseVersion,
            pausedReason: 'manual',
            startedAt: (run.startedAt ?? new Date()).toISOString(),
          },
        },
      },
    );
  } catch (err) {
    log.warn(
      `[interruptRestartPause] WorkflowRunUpdate(paused) emit failed (non-fatal) run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    ok: true,
    output: {
      runId,
      status: 'paused',
      pauseVersion: cas.pauseVersion,
      pauseCause: 'manual',
      alreadyPaused: false,
    },
  };
}
