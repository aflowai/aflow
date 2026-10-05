import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { getDatabase, resolveWorkflowForRunRevision } from '@aflow/database';
import type { Workflow, WorkflowRunResumeInput, WorkflowRunWakeupHandoff } from '@aflow/schemas';
import {
  ActorContextSchema,
  RESUME_REPLACE_OUTPUT_ATTEMPT_CAP,
  WorkflowRunStatusSchema,
  type ResumeCasErrorCode,
} from '@aflow/schemas';
import { getSessionState } from '@aflow/redis';
import {
  emitWorkflowProgress,
  emitRejectedBranchSkips,
  emitRunUpdated,
} from '@aflow/cybernetic-runtime';
import {
  buildResumeContract,
  deriveRunLiveness,
  loadRunById,
  listActiveRuns,
  recoverStalledRun,
  claimResumeLease,
  releaseResumeClaim,
  resumeRunWithClaim,
  rewritePausedRunContract,
  surfaceWorkflowResumeContract,
  type ClaimResumeLeaseResult,
} from '@aflow/cybernetic-runtime';
import { getOrchestratorLogger } from '../../../../../../lib/orchestratorLogger.js';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepError, parkInlineStepForWorkflowWait } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';
import { handleRetryFailedTask } from './retryFailedTask.js';
import { applyProvideInputResolution } from './provideInput.js';
import { applyReplaceOutputResolution } from './replaceOutput.js';
import { applyHumanReplaceOutputResolution } from './humanReplaceOutput.js';
import { applyFailTaskResolution } from './failTask.js';
import { applyRejectResolution } from './reject.js';
import { applyReExecuteResolution } from './reExecute.js';
import { emitResumeSuccess } from './emitResumeSuccess.js';
import {
  checkWorkflowCapabilityPreflight,
  checkWorkflowCredentialsPreflight,
  renderCapabilityPreflightFailureMessage,
  renderPreflightFailureMessage,
} from '../../../../helpers/workflowCredentialsPreflight.js';
import {
  gateWorkflowOperationGrants,
  renderResumeGrantGateFailureMessage,
} from '../../../../helpers/workflowGrantGate.js';

async function formatPausedRunsHint(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  limit: number,
): Promise<string> {
  try {
    const active = await listActiveRuns(db, tenantId, spaceId, { limit: 50 });
    const paused = active.filter((r) => r.status === 'paused').slice(0, limit);
    if (paused.length === 0) return '';
    const lines = paused.map(
      (r) =>
        `  - runId=${r.runId}, workflow=${r.workflowSlug}, pauseVersion=${String(r.pauseVersion)}, startedAt=${r.startedAt.toISOString()}`,
    );
    return (
      `\n\nAvailable paused runs in this space (newest first):\n${lines.join('\n')}\n\n` +
      'Refetch via `workflow.manage.get(slug=...)` to get the live `pausedRuns[].resumeContract`, ' +
      'then invoke `suggestedResumeCall.op` with its args.'
    );
  } catch {
    return '';
  }
}

const RESUME_CAS_ERROR_HTTP_HINT: Record<ResumeCasErrorCode, (runId: string) => string> = {
  RUN_NOT_PAUSED: (runId) =>
    'The run is not paused — already resumed, completed, or cancelled. If you just issued an ' +
    'approve/resume, your action most likely ALREADY LANDED (the run advanced past the pause) — ' +
    `this is NOT your action failing. Verify the run's true state with workflow.run.detail(runId=${runId}) ` +
    'before retrying.',
  STALE_PAUSE_VERSION: () =>
    'pauseVersion does not match the live row — the run was re-paused or resumed since the contract was surfaced. Re-fetch the surfaced contract and retry.',
  RESUME_IN_PROGRESS: () =>
    'Another resumer holds the lease — wait for it to expire or for the row to update, then retry.',
};

export async function handleWorkflowRunResume(
  args: InlineHandlerArgs,
  input: WorkflowRunResumeInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

  // 1. Load the run (slug now derived from the row, not the input).
  const run = await loadRunById(db, tenantIdStr, spaceId, input.runId);
  if (!run) {
    const pausedHint = await formatPausedRunsHint(db, tenantIdStr, spaceId, 5);
    await emitStepError(
      args,
      'WORKFLOW_RUN_NOT_FOUND',
      `Run ${input.runId} not found in this space.${pausedHint}`,
      startTime,
      'validation',
    );
    return;
  }
  const slug = run.workflowSlug;
  let workflow: Workflow;
  try {
    const resolved = await resolveWorkflowForRunRevision(
      db,
      args.context.tenantId,
      spaceId,
      slug,
      run.workflowRevision,
    );
    workflow = resolved.workflow;
  } catch (err) {
    await emitStepError(
      args,
      'WORKFLOW_NOT_FOUND',
      `Workflow ${slug}@${String(run.workflowRevision)} unresolvable: ${err instanceof Error ? err.message : String(err)}`,
      startTime,
      'validation',
    );
    return;
  }

  if (input.resolution.mode === 'retry_failed_task') {
    await handleRetryFailedTask({
      args,
      input,
      startTime,
      db,
      tenantIdStr,
      spaceId,
      run,
      workflow,
    });
    return;
  }

  // From here on, every code path is for a paused-run mode and
  // `pauseVersion` is required. The op input schema's `.superRefine`
  if (input.pauseVersion === undefined) {
    await emitStepError(
      args,
      'STALE_PAUSE_VERSION',
      `pauseVersion is required for resume mode "${input.resolution.mode}". ` +
        'Re-fetch the contract via `workflow.run.detail` and resubmit.',
      startTime,
      'validation',
    );
    return;
  }
  const pauseVersion: number = input.pauseVersion;

  // 2. Stalled-running recovery uses the legacy resumeRun path — no resume
  //    contract, no CAS. The lease-based flow only applies when status='paused'.
  const livenessResult = deriveRunLiveness(run);
  const isStalledRecovery = run.status === 'running' && livenessResult.liveness === 'stalled';
  if (isStalledRecovery) {
    if (input.resolution.mode !== 'acknowledge') {
      await emitStepError(
        args,
        'INVALID_RUN_STATUS',
        `Run ${run.runId} is stalled-running — only acknowledge resolution is valid for recovery.`,
        startTime,
        'validation',
      );
      return;
    }
    await recoverStalledRun(db, tenantIdStr, run.runId, args.context.runId);
    await emitResumeSuccess(
      args,
      run,
      workflow,
      livenessResult,
      startTime,
      db,
      tenantIdStr,
      spaceId,
    );
    return;
  }

  if (run.status !== 'paused') {
    const pausedHint = await formatPausedRunsHint(db, tenantIdStr, spaceId, 5);
    await emitStepError(
      args,
      'RUN_NOT_PAUSED',
      `Run ${run.runId} is "${run.status}" (liveness: ${livenessResult.liveness}). ` +
        RESUME_CAS_ERROR_HTTP_HINT.RUN_NOT_PAUSED(run.runId) +
        pausedHint,
      startTime,
      'validation',
    );
    return;
  }

  const surfaced = await surfaceWorkflowResumeContract(
    db,
    args.payloadStore,
    tenantIdStr,
    run.runId,
  );
  const pauseCause = surfaced?.contract.pauseCause ?? run.pausedReason;
  const requiresContract =
    pauseCause === 'task_contract_violation' || pauseCause === 'retry_budget_exceeded';
  if (requiresContract && !surfaced) {
    const causeLabel = run.pausedReason ?? 'unknown';
    await emitStepError(
      args,
      'RESUME_CONTRACT_UNAVAILABLE',
      `Run ${run.runId} paused on \`${causeLabel}\` but has no surfaced resume contract ` +
        '(payload retrieval or schema validation failed). Resuming without a contract would ' +
        'strand the failed task in `paused`. Manual intervention required to inspect the ' +
        '`workflow_runs` row and recover.',
      startTime,
      'validation',
    );
    return;
  }
  const advertisedModes = surfaced?.contract.allowedResumeModes ?? null;
  if (advertisedModes && !advertisedModes.includes(input.resolution.mode)) {
    await emitStepError(
      args,
      'RESOLUTION_MODE_NOT_ALLOWED',
      `Resolution mode "${input.resolution.mode}" is not advertised by this pause's resume contract. ` +
        `Allowed modes: [${advertisedModes.join(', ')}]. ` +
        'Use the `suggestedResumeCall` from the surfaced contract as your starting point.',
      startTime,
      'validation',
    );
    return;
  }

  if (input.resolution.mode === 'acknowledge') {
    const suggested = surfaced?.contract.suggestedResumeCall;
    if (suggested?.op === 'human.action_center.focus') {
      await emitStepError(
        args,
        'ACKNOWLEDGE_NOT_ALLOWED_ON_HITL',
        'This pause requires operator action on the workflow run surface — acknowledge would no-op past a HITL gate. ' +
          'Use workflow.run.resume with mode replace_output (approve/collect) or mode fail (reject) instead.',
        startTime,
        'validation',
      );
      return;
    }

    if (pauseCause === 'needs_credentials') {
      // Re-run on the raw workflow with the run's persisted connection pin so a
      // grant deferred to the run's connection (`binding.kind === 'connection'`)
      // is credential-checked against the real connection, not skipped — without
      // this the re-check could falsely pass (or, pre-flip, falsely pause).
      const connectionBindingId =
        run.metadata !== null && typeof run.metadata === 'object'
          ? ((run.metadata as Record<string, unknown>)['connectionBindingId'] as string | undefined)
          : undefined;
      const credentialsPreflight = await checkWorkflowCredentialsPreflight(
        db,
        args.context.tenantId,
        workflow,
        spaceId,
        typeof connectionBindingId === 'string' && connectionBindingId.length > 0
          ? connectionBindingId
          : undefined,
      );
      if (!credentialsPreflight.ok) {
        await emitStepError(
          args,
          'WORKFLOW_PRECHECK_CREDENTIALS_MISSING',
          renderPreflightFailureMessage(slug, credentialsPreflight),
          startTime,
          'validation',
        );
        return;
      }
    }
    if (pauseCause === 'needs_capability') {
      const capabilityPreflight = await checkWorkflowCapabilityPreflight(
        db,
        args.context.tenantId,
        workflow,
        spaceId,
      );
      if (!capabilityPreflight.ok) {
        await emitStepError(
          args,
          'WORKFLOW_PRECHECK_CAPABILITY_MISSING',
          renderCapabilityPreflightFailureMessage(slug, capabilityPreflight),
          startTime,
          'validation',
        );
        return;
      }
    }
  }

  // Operation tasks are enqueued directly and never pass step gating, so
  // without this a withheld operation runs after a single acknowledgement of
  // the very pause that named it. Modes that end the run are exempt — refusing
  // to let an operator close a run over a grant gap would strand it. Runs
  // before the resume lease so a refusal leaves the run paused as it was.
  if (input.resolution.mode !== 'fail' && input.resolution.mode !== 'reject') {
    const grantGate = await gateWorkflowOperationGrants({
      db,
      redis: args.redis,
      tenantId: args.context.tenantId,
      sessionId: args.context.runId,
      workflow,
    });
    if (grantGate.kind !== 'ok') {
      await emitStepError(
        args,
        grantGate.kind === 'ungranted'
          ? 'WORKFLOW_PRECHECK_OPERATION_NOT_GRANTED'
          : 'RUN_ACCESS_UNAVAILABLE',
        renderResumeGrantGateFailureMessage(slug, grantGate),
        startTime,
        grantGate.kind === 'ungranted' ? 'validation' : 'permission',
        false,
      );
      return;
    }
  }

  // 4. Acquire the resume lease (CAS on status='paused' AND pause_version=expected
  //    AND no live claim). Mismatches surface as typed CAS error codes.
  const claimResult: ClaimResumeLeaseResult = await claimResumeLease(
    db,
    tenantIdStr,
    run.runId,
    pauseVersion,
  );
  if (!claimResult.ok) {
    const casCode = claimResult.code;
    let extra = '';
    if (casCode === 'STALE_PAUSE_VERSION') {
      const fresh = await loadRunById(db, tenantIdStr, spaceId, run.runId);
      const liveVersion = fresh?.pauseVersion ?? run.pauseVersion;
      extra =
        ` Sent pauseVersion=${String(pauseVersion)}; live pauseVersion=${String(liveVersion)}. ` +
        'Refetch the contract via `workflow.manage.get(slug=...)` and use the freshest ' +
        '`pausedRuns[].resumeContract.suggestedResumeCall.args.pauseVersion`.';
    }
    await emitStepError(
      args,
      casCode,
      RESUME_CAS_ERROR_HTTP_HINT[casCode](run.runId) + extra,
      startTime,
      'validation',
    );
    return;
  }
  const claimToken = claimResult.claim.claimToken;

  // 4b. replace_output attempt cap — only after the lease CAS so promotion
  if (
    input.resolution.mode === 'replace_output' &&
    run.resumeAttemptCount >= RESUME_REPLACE_OUTPUT_ATTEMPT_CAP
  ) {
    if (surfaced?.contract.failedTaskId) {
      const failedTaskId = surfaced.contract.failedTaskId;
      const taskDef = workflow.tasks.find((t) => t.taskId === failedTaskId);
      const failedRow = run.tasks.find((t) => t.taskId === failedTaskId);
      if (taskDef && failedRow) {
        const promoted = buildResumeContract({
          pauseCause: 'retry_budget_exceeded',
          runId: run.runId,
          taskId: failedTaskId,
          taskDef,
          resumePrompt:
            `Task "${failedTaskId}" has exhausted replace_output attempts on this pause ` +
            `(cap=${String(RESUME_REPLACE_OUTPUT_ATTEMPT_CAP)}). ` +
            'Supply an acceptable output via replace_output or fail the task.',
          ...(surfaced.contract.expectedTaskOutputSchema
            ? { expectedTaskOutputSchema: surfaced.contract.expectedTaskOutputSchema }
            : {}),
          ...(surfaced.contract.replaceOutputSchema
            ? { replaceOutputSchema: surfaced.contract.replaceOutputSchema }
            : {}),
        });
        const rewritten = await rewritePausedRunContract({
          db,
          payloadStore: args.payloadStore,
          tenantId: tenantIdStr,
          runId: run.runId,
          taskId: failedTaskId,
          attempt: failedRow.attempt,
          contract: promoted,
          expectedPauseVersion: pauseVersion,
          resumeClaimToken: claimToken,
        });
        // The run stays `paused` across this rewrite, so nothing else on the
        // pause path announces it — but the contract an operator is being asked
        // to satisfy just changed, which moves the Action Center card.
        if (rewritten !== null) {
          await emitRunUpdated(args.redis, {
            tenantId: tenantIdStr,
            spaceId,
            runId: run.runId,
            workflowSlug: run.workflowSlug,
            status: 'paused',
          });
        }
      }
    }
    await releaseResumeClaim(db, tenantIdStr, run.runId, claimToken);
    await emitStepError(
      args,
      'RESUME_ATTEMPT_CAP_REACHED',
      `Run ${run.runId} has reached the cap of ${String(RESUME_REPLACE_OUTPUT_ATTEMPT_CAP)} replace_output attempts on this pause. ` +
        'The pause contract was promoted to `retry_budget_exceeded` when possible — refetch the contract, then use replace_output with a valid output or fail the task.',
      startTime,
      'validation',
    );
    return;
  }

  // 5. Mode dispatch. Each mode either commits via its own atomic helper
  //    (replace_output → commitReplaceOutputAndResume) or via the simple
  //    resumeRunWithClaim (acknowledge). On any pre-commit failure we
  //    release the claim so a follow-up resume can claim immediately.
  //
  let modeError: { code: string; message: string; details?: unknown } | null = null;
  let committed = false;
  let advanceTaskId: string | null = null;
  let committedFailTaskId: string | null = null;
  // Reject (operator "no" on an approval gate) skips the gated branch rather
  // than failing it, so post-commit routes to `dispatchNextOrTerminate` (NOT
  // `applyFailureMode`) — the same as the generic resume tail.
  let committedRejectTaskId: string | null = null;
  let reExecutedTask: { taskId: string; attempt: number } | null = null;
  try {
    if (input.resolution.mode === 'replace_output') {
      // Route human-task replace_output (intent: 'approve'
      // / 'collect') to the Pass-2-aware handler that auto-fills decidedAt +
      // decidedBy on the merged output. Do NOT gate on
      // `run.pausedReason === 'needs_decision'`: the ledger always
      // stores `pausedReason: 'task_paused'` regardless of task kind —
      // `'needs_decision'` only ever lives on the SURFACED CONTRACT's
      // `pauseCause`. A misrouted path hits the generic
      // `applyReplaceOutputResolution`, which validates the merged output
      // against the human-intent schema (requires decidedAt + decidedBy)
      // but never fills those fields — so every operator approval fails
      // with "Merged output failed validation: must have required property
      // 'decidedAt'".
      const isHumanPause = surfaced?.contract.pauseCause === 'needs_decision';
      const result = isHumanPause
        ? await applyHumanReplaceOutputResolution({
            args,
            db,
            tenantIdStr,
            run,
            workflow,
            surfaced,
            output: input.resolution.output,
            claimToken,
            actorUserId: 'operator',
          })
        : await applyReplaceOutputResolution({
            args,
            db,
            tenantIdStr,
            run,
            surfaced,
            output: input.resolution.output,
            claimToken,
          });
      if (!result.ok) {
        modeError = result.error;
      } else {
        committed = true;
        advanceTaskId = result.succeededTaskId;
        // Surface the just-resumed task's
        // terminal transition so the chat UI flips the row from
        // `paused` to `succeeded` immediately. The commit updates the
        // DB row but emits no `WorkflowTaskUpdate` event, so without
        // this the run-surface card keeps showing the paused approval
        // until a manual refresh. Mirrors the operator-UI
        // resume path (`executeOperatorWorkflowRunResume`).
        const resumedTaskLabel =
          workflow.tasks.find((t) => t.taskId === advanceTaskId)?.name ?? advanceTaskId;
        await emitWorkflowProgress(
          { db, redis: args.redis },
          {
            tenantId: tenantIdStr,
            runId: run.runId,
            event: {
              kind: 'WorkflowTaskUpdate',
              payload: {
                runId: run.runId,
                taskId: advanceTaskId,
                label: resumedTaskLabel,
                status: 'succeeded',
                attempt: 1,
                completedAt: new Date().toISOString(),
                summary: `Resolved via workflow.run.resume replace_output (human ${isHumanPause ? 'approve' : 'agent'}, pauseVersion=${String(input.pauseVersion ?? '?')}).`,
              },
            },
          },
        ).catch((err: unknown) => {
          getOrchestratorLogger().warn(
            `[handleWorkflowRunResume] emit WorkflowTaskUpdate(succeeded) failed for task=${advanceTaskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    } else if (input.resolution.mode === 'fail') {
      const result = await applyFailTaskResolution({
        db,
        tenantIdStr,
        run,
        workflow,
        surfaced,
        reason: input.resolution.reason,
        claimToken,
      });
      if (!result.ok) {
        modeError = result.error;
      } else {
        committed = true;
        committedFailTaskId = result.failedTaskId;
      }
    } else if (input.resolution.mode === 'reject') {
      const result = await applyRejectResolution({
        args,
        db,
        tenantIdStr,
        run,
        workflow,
        surfaced,
        ...(input.resolution.comment ? { comment: input.resolution.comment } : {}),
        claimToken,
        actorUserId: 'operator',
      });
      if (!result.ok) {
        modeError = result.error;
      } else {
        committed = true;
        committedRejectTaskId = result.skippedTaskId;
        advanceTaskId = result.skippedTaskId;
        // Surface the rejected approval's skip so the run-surface flips the
        // row paused→skipped immediately (mirror of the approve emit). The
        // commit updates the DB row but emits no WorkflowTaskUpdate.
        const skippedTaskLabel =
          workflow.tasks.find((t) => t.taskId === committedRejectTaskId)?.name ??
          committedRejectTaskId;
        await emitWorkflowProgress(
          { db, redis: args.redis },
          {
            tenantId: tenantIdStr,
            runId: run.runId,
            event: {
              kind: 'WorkflowTaskUpdate',
              payload: {
                runId: run.runId,
                taskId: committedRejectTaskId,
                label: skippedTaskLabel,
                status: 'skipped',
                attempt: 1,
                taskType: 'human',
                humanIntent: 'approve',
                completedAt: new Date().toISOString(),
                summary: `Rejected via workflow.run.resume reject (gated branch skipped, pauseVersion=${String(input.pauseVersion ?? '?')}).`,
                humanDecision: {
                  decision: 'rejected',
                  decidedAt: new Date().toISOString(),
                  ...(input.resolution.comment ? { comment: input.resolution.comment } : {}),
                },
              },
            },
          },
        ).catch((err: unknown) => {
          getOrchestratorLogger().warn(
            `[handleWorkflowRunResume] emit WorkflowTaskUpdate(skipped) failed for task=${committedRejectTaskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        // Surface the gated-branch descendants the commit pre-skipped, so the
        // run-surface flips them out of the forward-DAG ghost state immediately.
        await emitRejectedBranchSkips(
          { db, redis: args.redis },
          {
            tenantId: tenantIdStr,
            runId: run.runId,
            skipped: result.skippedDescendantTaskIds.map((id) => ({
              taskId: id,
              label: workflow.tasks.find((t) => t.taskId === id)?.name ?? id,
            })),
          },
        );
      }
    } else if (input.resolution.mode === 're_execute') {
      if (input.resolution.correctedInput !== undefined) {
        modeError = {
          code: 'RE_EXECUTE_CORRECTED_INPUT_NOT_IMPLEMENTED',
          message:
            '`re_execute.correctedInput` is not yet honored. Use `replace_output` on the ' +
            'upstream task whose output you want to fix, or pass guidance via `instructions`.',
        };
      } else {
        const result = await applyReExecuteResolution({
          args,
          db,
          tenantIdStr,
          run,
          workflow,
          surfaced,
          ...(input.resolution.instructions !== undefined
            ? { instructions: input.resolution.instructions }
            : {}),
          ...(input.resolution.remediationConfirmed !== undefined
            ? { remediationConfirmed: input.resolution.remediationConfirmed }
            : {}),
          claimToken,
          callingSessionId: args.context.runId,
        });
        if (!result.ok) {
          modeError = result.error;
        } else {
          committed = true;
          advanceTaskId = result.retriedTaskId;
          reExecutedTask = {
            taskId: result.retriedTaskId,
            attempt: result.retriedAttempt,
          };
        }
      }
    } else if (input.resolution.mode === 'provide_input') {
      const result = await applyProvideInputResolution({
        args,
        db,
        tenantIdStr,
        run,
        taskId: input.resolution.taskId,
        inputs: input.resolution.inputs,
        claimToken,
      });
      if (!result.ok) {
        modeError = result.error;
      } else {
        committed = true;
        advanceTaskId = input.resolution.taskId;
      }
    } else {
      // acknowledge.
      //
      const ackFailedTaskId = surfaced?.contract.failedTaskId;
      const ackTaskRow = ackFailedTaskId
        ? run.tasks.find((t) => t.taskId === ackFailedTaskId)
        : undefined;
      const ackReExecutes =
        (pauseCause === 'needs_credentials' || pauseCause === 'needs_capability') &&
        ackFailedTaskId !== undefined &&
        ackTaskRow?.status === 'paused';
      if (ackReExecutes) {
        const result = await applyReExecuteResolution({
          args,
          db,
          tenantIdStr,
          run,
          workflow,
          surfaced,
          remediationConfirmed: true,
          claimToken,
          callingSessionId: args.context.runId,
        });
        if (!result.ok) {
          modeError = result.error;
        } else {
          committed = true;
          advanceTaskId = result.retriedTaskId;
          reExecutedTask = { taskId: result.retriedTaskId, attempt: result.retriedAttempt };
        }
      } else {
        committed = await resumeRunWithClaim(db, tenantIdStr, run.runId, claimToken);
        if (!committed) {
          modeError = {
            code: 'RESUME_COMMIT_LOST',
            message:
              'Resume lease expired or was superseded between claim and commit. Re-fetch the surfaced contract and retry.',
          };
        }
      }
    }
  } catch (err) {
    modeError = {
      code: 'RESUME_HANDLER_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (modeError) {
    if (!committed) {
      await releaseResumeClaim(db, tenantIdStr, run.runId, claimToken);
    }
    await emitStepError(
      args,
      modeError.code,
      modeError.message,
      startTime,
      'validation',
      false,
      modeError.details,
    );
    return;
  }

  await emitRunUpdated(args.redis, {
    tenantId: tenantIdStr,
    spaceId,
    runId: run.runId,
    workflowSlug: run.workflowSlug,
    status: 'running',
  });

  const slugForPause = run.workflowSlug;
  const livenessForPause = livenessResult.liveness;
  await parkInlineStepForWorkflowWait(args, {
    kind: 'waiting_on_workflow_run' as const,
    runId: run.runId,
    slug: slugForPause,
    status: 'running' as const,
    priorLiveness: livenessForPause,
    ...(livenessResult.reason ? { priorLivenessReason: livenessResult.reason } : {}),
  });

  // Reference advanceTaskId so the previously-set value still has a
  // visible callsite — even though we no longer fire workflow_run_advance,
  // future Phase 2 telemetry may want to log which task triggered the
  // advance.
  if (advanceTaskId !== null) {
    getOrchestratorLogger().debug(
      `[handleWorkflowRunResume] resume succeeded; succeededTaskId=${advanceTaskId} run=${run.runId}`,
    );
  }

  // Harness rebind/dispatch:
  //   1. Re-bind: insert a new waiter row for the resuming Helmsman
  //      FIRST so subsequent pause/terminal outcomes (including the
  //      completeRun(failed) recovery below if step 2 or 3 throws)
  //      wake THIS session.
  //   2. Handoff — ONLY on `takeOver: true`: notify any other pending
  //      waiters (e.g., the original Helmsman that called
  //      workflow.run.start) with outcome 'handed_off' so they wake up
  //      knowing a different driver took over the run. The handoff
  //      filter excludes the just-inserted waiter (callingSessionId),
  //      so the order is safe. Without takeOver, resolving a pause
  //      leaves pre-existing waiters registered — they receive the
  //      run's later pause/terminal notifications as normal.
  //   3. Drive forward: call harness.dispatchNextOrTerminate to
  //      dispatch ready tasks (or complete the run if everything is
  //      terminal). Replaces the legacy `workflow_run_advance` →
  //      Driver scheduling tail.
  //
  // Failure handling: the resume CAS already committed (task=succeeded,
  // run=running). If rebind/dispatch fails AFTER that, the run is in
  // a degenerate state — still running but no in-flight dispatch.
  // Because step 1 (addWaiter) ran first, the resume step's PAUSED
  // (parked above) has a waiter row, so completeRun(failed) will
  // notifyWaiters('failed') and wake it cleanly with the failure
  // outcome. Helmsman sees the typed error rather than silently
  // parking on an orphan run.
  try {
    const { dispatchNextOrTerminate, notifyWaiters } =
      await import('../../../../../cybernetic/WorkflowRunHarness.js');
    const { addWaiter, loadPendingWaiters, emitCatchupToNewWaiter } =
      await import('@aflow/cybernetic-runtime');
    const harnessDeps = { db, redis: args.redis, payloadStore: args.payloadStore };
    const callingSessionId = args.context.runId;

    // 1. Re-bind: insert the new waiter FIRST so any later failure
    //    (handoff or dispatch) is recoverable via completeRun(failed)
    //    → notifyWaiters('failed') reaching this session.
    await addWaiter(db, tenantIdStr, {
      runId: run.runId,
      waiterSessionId: callingSessionId,
      waiterStepExecutionId: args.stepExecutionId,
    });

    await emitCatchupToNewWaiter(
      { db, redis: args.redis, payloadStore: args.payloadStore },
      {
        tenantId: tenantIdStr,
        spaceId: run.spaceId,
        runId: run.runId,
        waiterSessionId: callingSessionId,
        waiterStepExecutionId: args.stepExecutionId,
      },
    ).catch((err: unknown) => {
      getOrchestratorLogger().warn(
        `[handleWorkflowRunResume] emitCatchupToNewWaiter failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          tenantId: tenantIdStr,
          runId: run.runId,
          sessionId: callingSessionId,
        },
      );
    });

    // 2. Handoff old waiters — only on an explicit takeover. The
    //    just-inserted resume waiter must NOT receive `handed_off` — it
    //    would be marked notified and lose its surface anchor for the
    //    run it just took over. Pre-filter to decide whether to call
    //    notifyWaiters at all, AND pass the excludeSessionIds plumbing
    //    so notifyWaiters internally skips it in both the wakeup loop
    //    and the `WorkflowRunUpdate` emission.
    if (input.takeOver) {
      const oldWaiters = await loadPendingWaiters(db, tenantIdStr, run.runId);
      const otherWaiters = oldWaiters.filter((w) => w.waiterSessionId !== callingSessionId);
      if (otherWaiters.length > 0) {
        await notifyWaiters(harnessDeps, {
          tenantId: args.context.tenantId,
          runId: run.runId,
          outcome: 'handed_off',
          handoffPayload: await buildTakeoverHandoffPayload(
            args,
            db,
            tenantIdStr,
            spaceId,
            run.runId,
          ),
          excludeSessionIds: [callingSessionId],
        });
      }
    }

    // 3. Drive the run forward. Three branches:
    //    - fail   → applyFailureMode (cancel_siblings / isolate semantics).
    //    - re_execute → dispatchRetriedTask DIRECTLY. `dispatchNextOrTerminate`
    //      filters out tasks with existing rows (`dispatch.ts:756-757`),
    //      so the just-reset paused→running row would never get a worker
    //      via that path. Mirrors `handleRetryFailedTask`'s direct call.
    //    - everything else → dispatchNextOrTerminate (the generic resume tail).
    if (committedFailTaskId) {
      const { applyFailureMode } = await import('../../../../../cybernetic/harness/pauseResume.js');
      await applyFailureMode(harnessDeps, args.context.tenantId, run.runId, committedFailTaskId);
    } else if (reExecutedTask) {
      const { dispatchRetriedTask } =
        await import('../../../../../cybernetic/WorkflowRunHarness.js');
      try {
        await dispatchRetriedTask(harnessDeps, {
          tenantId: args.context.tenantId,
          runId: run.runId,
          taskId: reExecutedTask.taskId,
          attempt: reExecutedTask.attempt,
          helmsmanSessionId: callingSessionId as never,
        });
      } catch (dispatchErr) {
        const failingTaskId = reExecutedTask.taskId;
        const failingAttempt = reExecutedTask.attempt;
        const reason = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
        getOrchestratorLogger().error(
          `[handleWorkflowRunResume] re_execute dispatch failed after atomic commit — run=${run.runId} task=${failingTaskId}`,
          dispatchErr instanceof Error ? dispatchErr : undefined,
          {
            tenantId: tenantIdStr,
            runId: run.runId,
            taskId: failingTaskId,
            attempt: failingAttempt,
          },
        );
        const cyberneticRuntime = await import('@aflow/cybernetic-runtime');
        try {
          await cyberneticRuntime.casCompleteTask(db, tenantIdStr, {
            runId: run.runId,
            taskId: failingTaskId,
            attempt: failingAttempt,
            status: 'failed',
            completedAt: new Date(),
            failedAt: new Date(),
            failureReason: `re_execute dispatch failed: ${reason}`,
            errorCode: 'RE_EXECUTE_DISPATCH_FAILED',
            errorClassification: 'internal',
            errorRetryable: false,
          });
        } catch (casErr) {
          getOrchestratorLogger().error(
            `[handleWorkflowRunResume] defensive casCompleteTask threw — relying on applyFailureMode recovery`,
            casErr instanceof Error ? casErr : undefined,
            { tenantId: tenantIdStr, runId: run.runId, taskId: failingTaskId },
          );
        }
        try {
          const harness = await import('../../../../../cybernetic/WorkflowRunHarness.js');
          await harness.applyFailureMode(
            harnessDeps,
            args.context.tenantId,
            run.runId,
            failingTaskId,
          );
        } catch (recoveryErr) {
          getOrchestratorLogger().error(
            `[handleWorkflowRunResume] re_execute failure-mode recovery also failed for run=${run.runId} task=${failingTaskId}`,
            recoveryErr instanceof Error ? recoveryErr : undefined,
            { tenantId: tenantIdStr, runId: run.runId, taskId: failingTaskId },
          );
        }
        // No re-throw — `applyFailureMode` reaches `completeRun(failed)`
        // internally and `notifyWaiters('failed')` wakes the parked
        // Helmsman with the typed error. Matches `retryFailedTask.ts`'s
        // cascade exactly. Re-throwing would double-fire the outer catch's
        // `completeRun(failed)`, which is a no-op under the status guard
        // but emits a confusing duplicate log line.
      }
    } else {
      await dispatchNextOrTerminate(harnessDeps, args.context.tenantId, run.runId);
    }
  } catch (harnessErr) {
    const logger = getOrchestratorLogger();
    logger.error(
      `[handleWorkflowRunResume] harness re-bind / dispatch failed AFTER resume commit — failing run for run=${run.runId}`,
      harnessErr instanceof Error ? harnessErr : undefined,
      {
        tenantId: tenantIdStr,
        runId: run.runId,
        slug,
        error: harnessErr instanceof Error ? harnessErr.message : String(harnessErr),
      },
    );

    // Surface the failure: complete the run as 'failed' so
    // notifyWaiters wakes the resume step's PAUSED with outcome
    // 'failed'. The resumer sees the typed error; the run reaches
    // terminal cleanly rather than orphan-running.
    try {
      const { completeRun } = await import('../../../../../cybernetic/WorkflowRunHarness.js');
      await completeRun(
        { db, redis: args.redis, payloadStore: args.payloadStore },
        args.context.tenantId,
        run.runId,
        'failed',
      );
    } catch (completeErr) {
      // Last-resort log. The sweeper recovers an orphan running run
      // on the next sweep.
      getOrchestratorLogger().error(
        `[handleWorkflowRunResume] completeRun(failed) recovery also failed for run=${run.runId}`,
        completeErr instanceof Error ? completeErr : undefined,
        {
          tenantId: tenantIdStr,
          runId: run.runId,
        },
      );
    }
  }
}

async function buildTakeoverHandoffPayload(
  args: InlineHandlerArgs,
  db: PostgresJsDatabase,
  tenantIdStr: string,
  spaceId: string,
  runId: string,
): Promise<WorkflowRunWakeupHandoff> {
  const callingSessionId = args.context.runId;
  // Both reads are best-effort enrichment of optional fields: a throw here
  // would surface in the caller's rebind/dispatch catch and escalate to
  // completeRun(failed) on a run that just resumed successfully — omit
  // unreadable fields instead.
  let actorKind: WorkflowRunWakeupHandoff['actorKind'];
  try {
    const sessionState = await getSessionState(args.redis, args.context.tenantId, callingSessionId);
    if (sessionState?.actorContextJson) {
      actorKind = ActorContextSchema.parse(JSON.parse(sessionState.actorContextJson)).kind;
    }
  } catch {
    // Omitted.
  }
  let runStatusAtHandoff: WorkflowRunWakeupHandoff['runStatusAtHandoff'];
  try {
    const fresh = await loadRunById(db, tenantIdStr, spaceId, runId);
    const statusParse = WorkflowRunStatusSchema.safeParse(fresh?.status);
    if (statusParse.success) {
      runStatusAtHandoff = statusParse.data;
    }
  } catch {
    // Omitted.
  }
  return {
    resumedBy: callingSessionId,
    ...(actorKind ? { actorKind } : {}),
    ...(runStatusAtHandoff ? { runStatusAtHandoff } : {}),
    nextStep: 'released_do_not_poll',
  };
}
