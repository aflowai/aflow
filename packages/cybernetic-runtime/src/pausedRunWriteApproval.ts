import type { PayloadStore } from '@aflow/payload-store';
import { setWriteApprovalGrant } from '@aflow/redis';
import {
  type TenantId,
  type WriteApprovalRequestPayload,
  WriteApprovalRequestPayloadSchema,
  writeApprovalDenial,
} from '@aflow/schemas';
import {
  claimResumeLease,
  commitFailTaskAndResume,
  commitReExecutePausedTaskAndResume,
  loadRunById,
  releaseResumeClaim,
} from './ledger.js';
import type { WorkflowRunSummary, WorkflowTaskRow } from './ledger.js';
import {
  emitRunResumedRunning,
  type OperatorWorkflowRunResumeDeps,
  type OperatorWorkflowRunResumeHarnessHooks,
} from './operatorWorkflowRunResume.js';
import { emitRunUpdated } from './runEvents.js';
import { emitWorkflowProgress } from './workflowRunProgress.js';
import { getCyberneticLogger } from './logger.js';

/**
 * A write approval asked by an operation task inside a workflow run (Plan 253).
 *
 * The executor's `write_approval` pause reaches the run as a task pause: the
 * task row is `paused` holding the request payload as its `output_ref`, and the
 * run is `paused` / `task_paused` with that same ref as `paused_payload_ref`.
 * No session row exists, so the step plane never sees it; this is the read the
 * Action Center's run-plane source and its resolve share.
 */
export async function readPausedTaskWriteApproval(
  payloadStore: PayloadStore,
  run: Pick<WorkflowRunSummary, 'status' | 'pausedReason' | 'pausedPayloadRef'>,
  task: Pick<WorkflowTaskRow, 'status' | 'outputRef'>,
): Promise<WriteApprovalRequestPayload | null> {
  const ref = run.pausedPayloadRef;
  if (run.status !== 'paused' || run.pausedReason !== 'task_paused' || !ref) return null;
  // The run's pause is this task's only while the task still holds its payload.
  if (task.status !== 'paused' || task.outputRef !== ref) return null;
  let raw: unknown;
  try {
    raw = await payloadStore.retrieve(ref as never);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  if ((raw as Record<string, unknown>)['kind'] !== 'write_approval') return null;
  const parsed = WriteApprovalRequestPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface PausedRunWriteApprovalDecision {
  tenantId: TenantId;
  spaceId: string;
  runId: string;
  taskId: string;
  /** The pause the operator answered; any later pause is a different request. */
  pauseVersion: number;
  /** The authenticated operator — the resolve boundary's actor, never a caller's claim. */
  actorUserId: string;
  decision: 'approved' | 'denied';
  /** The operator's comment on an approval, or their reason for a denial. */
  reason?: string;
}

export type PausedRunWriteApprovalResult =
  | { ok: true; request: WriteApprovalRequestPayload }
  | {
      ok: false;
      /** `STALE_PAUSE`: the run is no longer paused on this request. The others are worth retrying. */
      code:
        | 'STALE_PAUSE'
        | 'RESUME_IN_PROGRESS'
        | 'RESUME_COMMIT_LOST'
        | 'RESUME_AT_PARALLEL_LIMIT'
        | 'GRANT_NOT_WRITTEN';
      message: string;
    };

/**
 * The operator's answer to a run's write approval, from the Action Center.
 *
 * The grant is minted here, keyed `(tenant, runId, requestHash)` — the key the
 * executor reads on the re-dispatched attempt, whose `runId` is the workflow
 * run's — and under the resume lease, so only the answer that wins the pause
 * writes one. Callers are the authenticated resolve boundary and nothing else:
 * an agent's `workflow.run.resume` can re-execute the task, but it carries no
 * decision, so the gate parks the call again.
 *
 * Approve re-executes the paused task on a fresh attempt, which the gate now
 * lets through. Deny fails the task with the same non-retryable `permission`
 * error a denied session step gets, carrying the operator's reason, and the
 * run's failure mode takes it from there — an optional task's dependents read
 * its failure as an outcome.
 */
export async function resolvePausedRunWriteApproval(
  deps: OperatorWorkflowRunResumeDeps,
  args: PausedRunWriteApprovalDecision,
  hooks: Pick<OperatorWorkflowRunResumeHarnessHooks, 'applyFailureMode' | 'dispatchRetriedTask'>,
): Promise<PausedRunWriteApprovalResult> {
  const tenantIdStr = args.tenantId as string;
  const { runId, taskId } = args;
  const stale = (why: string): PausedRunWriteApprovalResult => ({
    ok: false,
    code: 'STALE_PAUSE',
    message: `Run ${runId} is no longer waiting on this write approval: ${why}.`,
  });

  const run = await loadRunById(deps.db, tenantIdStr, args.spaceId, runId);
  if (!run) return stale('the run was not found');
  if (run.status !== 'paused' || run.pauseVersion !== args.pauseVersion) {
    return stale(`it is ${run.status} at pause ${String(run.pauseVersion)}`);
  }
  const task = run.tasks.find((t) => t.taskId === taskId);
  const request = task ? await readPausedTaskWriteApproval(deps.payloadStore, run, task) : null;
  if (!task || !request) return stale(`task "${taskId}" is not paused on one`);

  const claim = await claimResumeLease(deps.db, tenantIdStr, runId, args.pauseVersion);
  if (!claim.ok) {
    return claim.code === 'RESUME_IN_PROGRESS'
      ? {
          ok: false,
          code: 'RESUME_IN_PROGRESS',
          message: `Run ${runId} is being resumed by another answer; reload to see where it went.`,
        }
      : stale(claim.code);
  }
  const claimToken = claim.claim.claimToken;
  const release = () =>
    releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken).catch(() => false);

  try {
    await setWriteApprovalGrant(deps.redis, tenantIdStr, runId, {
      requestHash: request.requestHash,
      decision: args.decision,
      approvedBy: args.actorUserId,
      decidedAt: new Date().toISOString(),
      ...(args.reason ? { reason: args.reason } : {}),
    });
  } catch (err) {
    await release();
    getCyberneticLogger().error(
      `[resolvePausedRunWriteApproval] the grant for run=${runId} could not be written; the run is still paused`,
      err instanceof Error ? err : undefined,
    );
    return {
      ok: false,
      code: 'GRANT_NOT_WRITTEN',
      message: `The decision could not be recorded, so run ${runId} is still waiting on it. Answer it again.`,
    };
  }

  if (args.decision === 'approved') {
    const committed = await commitReExecutePausedTaskAndResume(deps.db, tenantIdStr, {
      runId,
      claimToken,
      taskId,
      expectedAttempt: task.attempt,
    });
    if (committed !== 'committed') {
      await release();
      if (committed === 'task_row_not_paused') return stale(`task "${taskId}" moved on`);
      return committed === 'at_parallel_limit'
        ? {
            ok: false,
            code: 'RESUME_AT_PARALLEL_LIMIT',
            message: `Run ${runId} is at its parallel-task limit. Approve again once a running task finishes.`,
          }
        : {
            ok: false,
            code: 'RESUME_COMMIT_LOST',
            message: `Run ${runId}'s resume lease lapsed before the approval landed. Approve again.`,
          };
    }
    await emitRunResumedRunning(deps, tenantIdStr, runId, run);
    await emitRunUpdated(deps.redis, {
      tenantId: tenantIdStr,
      spaceId: args.spaceId,
      runId,
      workflowSlug: run.workflowSlug,
      status: 'running',
    });
    await hooks.dispatchRetriedTask(deps, args.tenantId, runId, taskId);
    return { ok: true, request };
  }

  const denial = writeApprovalDenial(request, args.reason);
  const completedAt = new Date();
  const committed = await commitFailTaskAndResume(deps.db, tenantIdStr, {
    runId,
    claimToken,
    taskId,
    attempt: task.attempt,
    reason: denial.message,
    summary: 'The operator denied this write in the Action Center.',
    completedAt,
    error: {
      code: denial.code,
      classification: denial.classification,
      retryable: denial.retryable,
    },
  });
  if (committed !== 'committed') {
    await release();
    return committed === 'task_row_state_mismatch'
      ? stale(`task "${taskId}" moved on`)
      : {
          ok: false,
          code: 'RESUME_COMMIT_LOST',
          message: `Run ${runId}'s resume lease lapsed before the denial landed. Deny again.`,
        };
  }
  await emitWorkflowProgress(
    { db: deps.db, redis: deps.redis },
    {
      tenantId: tenantIdStr,
      runId,
      event: {
        kind: 'WorkflowTaskUpdate',
        payload: {
          runId,
          taskId,
          label: taskId,
          status: 'failed',
          attempt: task.attempt,
          completedAt: completedAt.toISOString(),
          failureReason: denial.message,
          ...(task.operationId ? { operationId: task.operationId } : {}),
        },
      },
    },
  ).catch((err: unknown) => {
    getCyberneticLogger().warn(
      `[resolvePausedRunWriteApproval] emit WorkflowTaskUpdate(failed) failed for task=${taskId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  await emitRunUpdated(deps.redis, {
    tenantId: tenantIdStr,
    spaceId: args.spaceId,
    runId,
    workflowSlug: run.workflowSlug,
    status: 'running',
  });
  await hooks.applyFailureMode(deps, args.tenantId, runId, taskId);
  return { ok: true, request };
}
