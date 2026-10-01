import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import type { HumanApprovalCall, TenantId, WorkflowRunResumeInput } from '@aflow/schemas';
import {
  HostApprovedPushSchema,
  RESUME_REPLACE_OUTPUT_ATTEMPT_CAP,
  normalizeInstructionsForStorage,
} from '@aflow/schemas';
import { resolveWorkflowForRunRevision } from '@aflow/database';
import { hostPushRequestHash, setWriteApprovalGrant } from '@aflow/redis';
import {
  claimResumeLease,
  releaseResumeClaim,
  loadRunById,
  resumeRunWithClaim,
  commitReExecutePausedTaskAndResume,
} from './ledger.js';
import { computeBlockedDescendantsToClearForRetry } from './scheduling/graph.js';
import { validateInstructionTaskTargets } from './parentTaskInputs.js';
import { surfaceWorkflowResumeContract } from './workflowResume.js';
import {
  applyHumanReplaceOutputResolution,
  applyFailTaskResolution,
  applyRejectResolution,
} from './workflowRunResumeModes.js';
import { emitWorkflowProgress, emitRejectedBranchSkips } from './workflowRunProgress.js';
import { emitRunUpdated } from './runEvents.js';
import { resolveUserLabel } from './userLabels.js';
import { getCyberneticLogger } from './logger.js';

export interface OperatorWorkflowRunResumeDeps {
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore: PayloadStore;
}

export interface OperatorWorkflowRunResumeHarnessHooks {
  applyFailureMode: (
    deps: OperatorWorkflowRunResumeDeps,
    tenantId: TenantId,
    runId: string,
    failedTaskId: string,
  ) => Promise<void>;
  dispatchNextOrTerminate: (
    deps: OperatorWorkflowRunResumeDeps,
    tenantId: TenantId,
    runId: string,
  ) => Promise<void>;
  dispatchRetriedTask: (
    deps: OperatorWorkflowRunResumeDeps,
    tenantId: TenantId,
    runId: string,
    taskId: string,
  ) => Promise<void>;
}

export type OperatorWorkflowRunResumeResult =
  { ok: true; runId: string } | { ok: false; code: string; message: string };

/**
 * Plan 253's write-approval grant, for a host push: an operator approving a
 * human task whose `approvedCall` is a push is the decision the host executor
 * needs before it sends a range its scan did not clear. Minted here and only
 * here — the operator's resolve, which holds the real actor — keyed by tenant,
 * run and the hash of exactly that push, so neither an agent-driven resume nor
 * anything the push's own input says can stand in for it. A decline goes
 * through `reject` and mints nothing.
 */
async function recordHostPushApproval(
  redis: Redis,
  args: { tenantId: string; runId: string; approvedBy: string; approvedCall: HumanApprovalCall },
): Promise<void> {
  if (args.approvedCall.op !== 'host.process.exec') return;
  const push = HostApprovedPushSchema.safeParse(args.approvedCall.input);
  if (!push.success) return;
  await setWriteApprovalGrant(redis, args.tenantId, args.runId, {
    requestHash: hostPushRequestHash(push.data),
    decision: 'approved',
    approvedBy: args.approvedBy,
    decidedAt: new Date().toISOString(),
  });
}

export async function executeOperatorWorkflowRunResume(
  deps: OperatorWorkflowRunResumeDeps,
  args: {
    tenantId: TenantId;
    spaceId: string;
    userId: string;
    input: WorkflowRunResumeInput;
  },
  hooks: OperatorWorkflowRunResumeHarnessHooks,
): Promise<OperatorWorkflowRunResumeResult> {
  const tenantIdStr = args.tenantId as string;
  const { runId } = args.input;

  if (args.input.resolution.mode === 'retry_failed_task') {
    return {
      ok: false,
      code: 'RETRY_VIA_AGENT',
      message: 'retry_failed_task must be invoked by Helmsman, not the operator UI.',
    };
  }

  const pauseVersion = args.input.pauseVersion;
  if (pauseVersion === undefined) {
    return { ok: false, code: 'STALE_PAUSE_VERSION', message: 'pauseVersion is required.' };
  }

  const run = await loadRunById(deps.db, tenantIdStr, args.spaceId, runId);
  if (run?.status !== 'paused') {
    return { ok: false, code: 'RUN_NOT_PAUSED', message: `Run ${runId} is not paused.` };
  }

  const resolved = await resolveWorkflowForRunRevision(
    deps.db,
    args.tenantId,
    args.spaceId,
    run.workflowSlug,
    run.workflowRevision,
  );

  const surfaced = await surfaceWorkflowResumeContract(
    deps.db,
    deps.payloadStore,
    tenantIdStr,
    runId,
  );

  const advertisedModes = surfaced?.contract.allowedResumeModes ?? null;
  if (advertisedModes && !advertisedModes.includes(args.input.resolution.mode)) {
    return {
      ok: false,
      code: 'RESOLUTION_MODE_NOT_ALLOWED',
      message: `Mode "${args.input.resolution.mode}" not allowed. Allowed: [${advertisedModes.join(', ')}].`,
    };
  }

  if (
    args.input.resolution.mode === 'acknowledge' &&
    surfaced?.contract.suggestedResumeCall?.op === 'human.action_center.focus'
  ) {
    return {
      ok: false,
      code: 'ACKNOWLEDGE_NOT_ALLOWED_ON_HITL',
      message: 'Use replace_output or fail for this HITL pause.',
    };
  }

  if (
    args.input.resolution.mode === 'replace_output' &&
    run.resumeAttemptCount >= RESUME_REPLACE_OUTPUT_ATTEMPT_CAP
  ) {
    return {
      ok: false,
      code: 'RESUME_ATTEMPT_CAP_REACHED',
      message: 'Replace attempt cap reached.',
    };
  }

  const claimResult = await claimResumeLease(deps.db, tenantIdStr, runId, pauseVersion);
  if (!claimResult.ok) {
    return { ok: false, code: claimResult.code, message: claimResult.code };
  }
  const claimToken = claimResult.claim.claimToken;

  try {
    const resolution = args.input.resolution;
    let committedFailTaskId: string | null = null;
    let reExecutedTaskId: string | null = null;

    if (resolution.mode === 'replace_output') {
      // The ledger stores `pausedReason: 'task_paused'`
      // for ALL task pauses (human + agent signal_blocked alike); the
      // human-task discriminator (`'needs_decision'`) lives on
      // `surfaced.contract.pauseCause`, not on the run row. The inline
      // `workflow.run.resume` handler in `resume.ts` checks the surfaced
      // contract the same way; this is the operator-UI mirror of that
      // path. Gating on the run row instead makes every Approve click
      // on the run-surface card 400 with OPERATOR_REPLACE_NOT_SUPPORTED.
      if (surfaced?.contract.pauseCause !== 'needs_decision') {
        await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken);
        return {
          ok: false,
          code: 'OPERATOR_REPLACE_NOT_SUPPORTED',
          message: 'Operator UI only supports human-task pauses in this pass.',
        };
      }
      const result = await applyHumanReplaceOutputResolution({
        db: deps.db,
        tenantIdStr,
        run,
        workflow: resolved.workflow,
        surfaced,
        output: resolution.output,
        claimToken,
        actorUserId: args.userId,
        payloadStore: deps.payloadStore,
        recordApproval: (approvedCall) =>
          recordHostPushApproval(deps.redis, {
            tenantId: tenantIdStr,
            runId,
            approvedBy: args.userId,
            approvedCall,
          }),
        storeContext: {
          tenantId: args.tenantId,
          runId,
          stepExecutionId: '00000000-0000-0000-0000-000000000001',
          attempt: 1,
        },
      });
      if (!result.ok) {
        await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken);
        return { ok: false, code: result.error.code, message: result.error.message };
      }
      // Emit the resumed task's terminal
      // transition so the chat UI sees `approve-submit` flip from
      // `paused` to `succeeded` immediately. Without this, the commit
      // path updates the DB row but never surfaces a `WorkflowTaskUpdate`
      // event, so the operator-side run-surface keeps rendering the
      // paused approval row until a manual refresh re-fetches the run
      // detail. dispatchNextOrTerminate (called below) emits updates
      // for the NEXT tasks but never for the one we just resumed.
      const taskId = surfaced?.contract.failedTaskId;
      const taskLabel = resolved?.workflow?.tasks.find((t) => t.taskId === taskId)?.name ?? taskId;
      if (taskId) {
        // Stamp the resolved-decision trace so the operator who just approved
        // sees the surface's decision pill immediately — without waiting for a
        // BFF re-fetch (which carries it authoritatively, comment included).
        // This branch is the approve path; reject is `mode: 'fail'` below.
        const decisionComment =
          resolution.output &&
          typeof resolution.output === 'object' &&
          typeof (resolution.output as { comment?: unknown }).comment === 'string'
            ? (resolution.output as { comment: string }).comment
            : undefined;
        // Show the approver's name, not their UUID. Display-only + best-effort:
        // fall back to the raw id if the lookup fails (never block the resume).
        const decidedByLabel = args.userId
          ? await resolveUserLabel(deps.db, args.userId).catch(() => args.userId)
          : undefined;
        const humanDecision = {
          decision: 'approved' as const,
          decidedAt: new Date().toISOString(),
          ...(decidedByLabel ? { decidedBy: decidedByLabel } : {}),
          ...(decisionComment ? { comment: decisionComment } : {}),
        };
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
                label: taskLabel ?? taskId,
                status: 'succeeded',
                attempt: 1,
                taskType: 'human',
                humanIntent: 'approve',
                completedAt: new Date().toISOString(),
                summary: `Resolved via workflow.run.resume replace_output (human approve, pauseVersion=${String(pauseVersion)}).`,
                humanDecision,
              },
            },
          },
        ).catch((err: unknown) => {
          getCyberneticLogger().warn(
            `[executeOperatorWorkflowRunResume] emit WorkflowTaskUpdate(succeeded) failed for task=${taskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    } else if (resolution.mode === 'fail') {
      const rejectReason = resolution.reason;
      const result = await applyFailTaskResolution({
        db: deps.db,
        tenantIdStr,
        run,
        surfaced,
        reason: rejectReason,
        claimToken,
      });
      if (!result.ok) {
        await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken);
        return { ok: false, code: result.error.code, message: result.error.message };
      }
      committedFailTaskId = result.failedTaskId;
      // Symmetric with the approve (`replace_output`) emit above — the fail
      // commit updates the DB row but `applyFailureMode` only emits updates
      // for downstream cancellation / run termination, not the human task
      // the operator just rejected. Without this, the run-surface keeps the
      // paused approval row until a manual refresh re-fetches detail.
      const taskId = result.failedTaskId;
      const taskRow = run.tasks.find((t) => t.taskId === taskId);
      const taskLabel = resolved?.workflow?.tasks.find((t) => t.taskId === taskId)?.name ?? taskId;
      if (taskId) {
        const decidedByLabel = args.userId
          ? await resolveUserLabel(deps.db, args.userId).catch(() => args.userId)
          : undefined;
        const humanDecision = {
          decision: 'rejected' as const,
          ...(decidedByLabel ? { decidedBy: decidedByLabel } : {}),
          ...(rejectReason ? { comment: rejectReason } : {}),
        };
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
                label: taskLabel ?? taskId,
                status: 'failed',
                attempt: taskRow?.attempt ?? 1,
                taskType: 'human',
                completedAt: new Date().toISOString(),
                failureReason: rejectReason,
                summary: `Rejected via workflow.run.resume fail (pauseVersion=${String(pauseVersion)}).`,
                humanDecision,
              },
            },
          },
        ).catch((err: unknown) => {
          getCyberneticLogger().warn(
            `[executeOperatorWorkflowRunResume] emit WorkflowTaskUpdate(failed) failed for task=${taskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    } else if (resolution.mode === 'reject') {
      // Operator "no" on an approval gate: skip the gated branch instead of
      // failing it, so the approve task's always-on descendants (e.g. learning
      // tasks) still run. Routes to `dispatchNextOrTerminate` below (NOT
      // `applyFailureMode`).
      const result = await applyRejectResolution({
        db: deps.db,
        tenantIdStr,
        run,
        workflow: resolved.workflow,
        surfaced,
        ...(resolution.comment ? { comment: resolution.comment } : {}),
        claimToken,
        actorUserId: args.userId,
        payloadStore: deps.payloadStore,
        storeContext: {
          tenantId: args.tenantId,
          runId,
          stepExecutionId: '00000000-0000-0000-0000-000000000002',
          attempt: 1,
        },
      });
      if (!result.ok) {
        await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken);
        return { ok: false, code: result.error.code, message: result.error.message };
      }
      // Surface the rejected decision so the run-surface flips the approval row
      // from `paused` to `skipped` immediately (mirror of the approve emit).
      const taskId = result.skippedTaskId;
      const taskRow = run.tasks.find((t) => t.taskId === taskId);
      const taskLabel = resolved?.workflow?.tasks.find((t) => t.taskId === taskId)?.name ?? taskId;
      const decidedByLabel = args.userId
        ? await resolveUserLabel(deps.db, args.userId).catch(() => args.userId)
        : undefined;
      const humanDecision = {
        decision: 'rejected' as const,
        decidedAt: new Date().toISOString(),
        ...(decidedByLabel ? { decidedBy: decidedByLabel } : {}),
        ...(resolution.comment ? { comment: resolution.comment } : {}),
      };
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
              label: taskLabel ?? taskId,
              status: 'skipped',
              attempt: taskRow?.attempt ?? 1,
              taskType: 'human',
              humanIntent: 'approve',
              completedAt: new Date().toISOString(),
              summary: `Rejected via workflow.run.resume reject (gated branch skipped, pauseVersion=${String(pauseVersion)}).`,
              humanDecision,
            },
          },
        },
      ).catch((err: unknown) => {
        getCyberneticLogger().warn(
          `[executeOperatorWorkflowRunResume] emit WorkflowTaskUpdate(skipped) failed for task=${taskId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      // Surface the gated-branch descendants the commit pre-skipped, so the
      // run-surface flips them out of the forward-DAG ghost state immediately.
      await emitRejectedBranchSkips(
        { db: deps.db, redis: deps.redis },
        {
          tenantId: tenantIdStr,
          runId,
          skipped: result.skippedDescendantTaskIds.map((id) => ({
            taskId: id,
            label: resolved?.workflow?.tasks.find((t) => t.taskId === id)?.name ?? id,
          })),
        },
      );
    } else if (resolution.mode === 'acknowledge') {
      if (surfaced?.contract.failedTaskId) {
        await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken);
        return {
          ok: false,
          code: 'ACKNOWLEDGE_TASK_BACKED_NOT_SUPPORTED',
          message:
            'This pause is task-backed; acknowledge via the operator route would strand the paused task. ' +
            'Resume through Helmsman (workflow.run.resume), which re-executes the blocked task after credentials are fixed.',
        };
      }
      // A startup preflight pause is raised before any task exists, so it
      // carries no `failedTaskId` and the guard above does not catch it.
      // Acknowledging a capability pause here would release the run without
      // re-asking the question that paused it, and operation tasks dispatch
      // directly without passing step gating — nothing downstream would catch
      // an authority that is still missing. Only the Helmsman resume path
      // re-runs that check. Scoped to `needs_capability`: a credentials pause
      // resolves at the call itself, which refuses on its own, so refusing it
      // here would withdraw a route operators already use.
      if (surfaced?.contract.pauseCause === 'needs_capability') {
        await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken);
        return {
          ok: false,
          code: 'ACKNOWLEDGE_CAPABILITY_PAUSE_NOT_SUPPORTED',
          message:
            'This run paused because its authority does not cover an operation it would dispatch. ' +
            'Acknowledging here would resume it without re-checking, and its operation tasks dispatch ' +
            'without a second gate. Resume through Helmsman (workflow.run.resume), which re-runs the ' +
            'check and only releases the run once the capability is actually in place.',
        };
      }
      const committed = await resumeRunWithClaim(deps.db, tenantIdStr, runId, claimToken);
      if (!committed) {
        await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken);
        return {
          ok: false,
          code: 'RESUME_COMMIT_LOST',
          message: 'Acknowledge commit lost a claim/version race; reload and retry.',
        };
      }

      await emitRunResumedRunning(deps, tenantIdStr, runId, run);
    } else if (resolution.mode === 're_execute') {
      const failedTaskId = surfaced?.contract.failedTaskId;
      const failedRow = failedTaskId ? run.tasks.find((t) => t.taskId === failedTaskId) : undefined;
      if (!failedTaskId || !failedRow) {
        await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken);
        return {
          ok: false,
          code: 'RE_EXECUTE_NO_TASK',
          message: 'This pause has no task-backed contract; re_execute is not applicable.',
        };
      }

      // Race: the interrupted task finished before/at commit → continue the run
      // as-is (acknowledge semantics) rather than reset a terminal row. The
      // commit rolls back its own run-flip on a task race, so on either branch
      // the run is still paused with the claim held.
      const taskFinishedRace = failedRow.status !== 'paused';
      if (!taskFinishedRace) {
        const instructions = resolution.instructions;
        if (instructions !== undefined) {
          const instructionTargets = validateInstructionTaskTargets(
            resolved.workflow,
            instructions,
            { consequence: 'the run was not resumed', retryAction: 'resume again' },
          );
          if (!instructionTargets.ok) {
            await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken);
            return {
              ok: false,
              code: 'INSTRUCTION_TARGETS_INVALID',
              message: instructionTargets.message,
            };
          }
        }
        const parentInstructionsPatch =
          instructions !== undefined
            ? (normalizeInstructionsForStorage(instructions) as Record<string, unknown>)
            : undefined;
        const remediationNote =
          typeof instructions === 'string'
            ? instructions
            : Array.isArray(instructions)
              ? instructions.find((e) => e.taskId === failedTaskId)?.text
              : undefined;
        const descendantTaskIds = [
          ...computeBlockedDescendantsToClearForRetry(
            resolved.workflow.tasks,
            run.tasks,
            failedTaskId,
          ),
        ];
        const commitResult = await commitReExecutePausedTaskAndResume(deps.db, tenantIdStr, {
          runId,
          claimToken,
          taskId: failedTaskId,
          expectedAttempt: failedRow.attempt,
          descendantTaskIds,
          ...(remediationNote ? { remediationNote } : {}),
          ...(parentInstructionsPatch ? { parentInstructionsPatch } : {}),
        });
        if (commitResult === 'claim_lost') {
          await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken);
          return { ok: false, code: 'RESUME_COMMIT_LOST', message: 'Resume lease lost at commit.' };
        }
        if (commitResult === 'at_parallel_limit') {
          // Must not fall through: acknowledge-continue would resume the run and
          // report success for a task that was never re-executed.
          await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken);
          return {
            ok: false,
            code: 'RESUME_AT_PARALLEL_LIMIT',
            message:
              `Run ${runId} is at its parallel-task limit, so re-executing "${failedTaskId}" would ` +
              'put it over. Wait for an in-flight task to finish and resume again — nothing changed.',
          };
        }
        if (commitResult === 'committed') {
          reExecutedTaskId = failedTaskId;
        }
        // 'task_row_not_paused' falls through to the acknowledge-continue below.
      }
      if (reExecutedTaskId === null) {
        // Either the task already finished, or the commit lost a task-row race.
        const committed = await resumeRunWithClaim(deps.db, tenantIdStr, runId, claimToken);
        if (!committed) {
          await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken);
          return { ok: false, code: 'RESUME_COMMIT_LOST', message: 'Resume claim/version race.' };
        }
      }
      await emitRunResumedRunning(deps, tenantIdStr, runId, run);
    } else {
      await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken);
      return {
        ok: false,
        code: 'MODE_NOT_SUPPORTED',
        message: `Operator UI does not support mode "${resolution.mode}".`,
      };
    }

    // The commit above flipped the run paused→running; the dispatch hooks
    // below may take it terminal, and completeRun emits that transition
    // itself — emitting here first keeps the event order truthful.
    await emitRunUpdated(deps.redis, {
      tenantId: tenantIdStr,
      spaceId: args.spaceId,
      runId,
      workflowSlug: run.workflowSlug,
      status: 'running',
    });

    if (committedFailTaskId) {
      await hooks.applyFailureMode(deps, args.tenantId, runId, committedFailTaskId);
    } else if (reExecutedTaskId) {
      await hooks.dispatchRetriedTask(deps, args.tenantId, runId, reExecutedTaskId);
    } else {
      await hooks.dispatchNextOrTerminate(deps, args.tenantId, runId);
    }

    return { ok: true, runId };
  } catch (err) {
    await releaseResumeClaim(deps.db, tenantIdStr, runId, claimToken).catch(() => {});
    getCyberneticLogger().error(
      '[executeOperatorWorkflowRunResume] failed',
      err instanceof Error ? err : undefined,
    );
    return {
      ok: false,
      code: 'RESUME_HANDLER_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Emit the live `WorkflowRunUpdate(running)` after an operator resume flips the
 * run paused→running, so the surface card leaves `paused` immediately. The
 * operator route doesn't go through Helmsman's run-level emit, and per-task
 * dispatch emits only `WorkflowTaskUpdate`. Best-effort — the resume already
 * committed, so an emit failure must not fail it.
 */
async function emitRunResumedRunning(
  deps: OperatorWorkflowRunResumeDeps,
  tenantIdStr: string,
  runId: string,
  run: { workflowSlug: string; pauseVersion: number; startedAt: Date },
): Promise<void> {
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
            status: 'running',
            pauseVersion: run.pauseVersion,
            startedAt: run.startedAt.toISOString(),
          },
        },
      },
    );
  } catch (err) {
    getCyberneticLogger().warn(
      `[executeOperatorWorkflowRunResume] WorkflowRunUpdate(running) emit failed (non-fatal) run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
