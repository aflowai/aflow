import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  claimHumanTask as ledgerClaimHumanTask,
  buildHumanTaskHydrationFields,
  resolveActionPreview,
  buildDisplayActionPreview,
  runContextFromDetail,
  buildDurableHydration,
  encodeInlineHydrationRef,
  type WorkflowRunDetail,
} from '@aflow/cybernetic-runtime';
import type {
  PayloadRef,
  SessionId,
  StepExecutionId,
  TenantId,
  WorkflowTask,
  TrialExecutionState,
} from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import { emitTaskUpdate } from './helpers.js';
import { pauseRunOnly } from './pauseResume.js';
import type { HarnessDeps } from './types.js';

export interface DispatchHumanWorkflowTaskArgs {
  deps: HarnessDeps;
  tenantId: TenantId;
  tenantIdStr: string;
  runId: string;
  taskId: string;
  attempt: number;
  run: WorkflowRunDetail;
  task: WorkflowTask;
}

/**
 * What a pause records about the subject.
 *
 * A conversational subject's answer is read from the pause prompt, and the
 * harness substitutes a placeholder when the task supplied none. The
 * placeholder is non-empty, so downstream it is indistinguishable from a short
 * reply and every reader grades silence as a response. This records which it is
 * while that is still knowable.
 *
 * Only a `collect` pause carries an answer. An approval gate's prompt is the
 * decision put to the operator, so its absence is not the subject going quiet —
 * stamping one would report every approval-gated skill run as an execution
 * failure.
 *
 * Exported because the test for this rule must exercise it rather than restate
 * it: a test holding its own copy asserts that the copy is self-consistent and
 * says nothing about what dispatch does.
 */
export function pauseExecutionState(task: {
  intent?: 'collect' | 'approve' | undefined;
  pauseInstruction?: string | undefined;
}): TrialExecutionState {
  const intent = task.intent ?? 'collect';
  const supplied = task.pauseInstruction;
  return intent === 'collect' && (supplied === undefined || supplied.trim().length === 0)
    ? 'no_terminal_reply'
    : 'completed';
}

export async function dispatchHumanWorkflowTask(
  args: DispatchHumanWorkflowTaskArgs,
): Promise<void> {
  const { deps, tenantId, tenantIdStr, runId, taskId, attempt, run, task } = args;
  const log = getOrchestratorLogger().child({
    component: 'WorkflowRunHarness:dispatchHumanTask',
    runId,
    taskId,
    attempt,
  });

  const humanIntent = task.intent ?? 'collect';
  const subjectReply = task.pauseInstruction;
  const executionState = pauseExecutionState({
    intent: humanIntent,
    pauseInstruction: subjectReply,
  });
  const humanInputRef = `inline:${Buffer.from(
    JSON.stringify({ prompt: subjectReply ?? `Provide input for: ${task.name}` }),
  ).toString('base64')}`;

  const replaceOutputSchema: Record<string, unknown> =
    humanIntent === 'approve'
      ? {
          type: 'object',
          required: ['decision'],
          properties: {
            decision: { const: 'approved' },
            comment: { type: 'string', maxLength: 2000 },
            approvedCall: {
              type: 'object',
              required: ['op', 'input'],
              properties: { op: { type: 'string' }, input: {} },
            },
          },
          additionalProperties: false,
        }
      : (task.outputContract?.schema ?? {
          type: 'object',
          additionalProperties: true,
        });
  const expectedOutputSchema: Record<string, unknown> =
    humanIntent === 'approve'
      ? {
          type: 'object',
          required: ['decision', 'decidedAt', 'decidedBy'],
          properties: {
            decision: { const: 'approved' },
            comment: { type: 'string' },
            decidedAt: { type: 'string', format: 'date-time' },
            decidedBy: { type: 'string' },
            approvedCall: {
              type: 'object',
              required: ['op', 'input'],
              properties: { op: { type: 'string' }, input: {} },
            },
          },
          additionalProperties: false,
        }
      : replaceOutputSchema;
  const allowedResumeModes =
    humanIntent === 'approve'
      ? // `reject` is the operator "no" (skip the gated branch, reject-but-learn);
        // `fail` stays for a genuine approve-task failure (tool error) that should
        // block descendants.
        (['replace_output', 'reject', 'fail'] as const)
      : (['replace_output'] as const);
  const resumePrompt = task.pauseInstruction ?? `Provide input to complete task: ${task.name}`;
  const humanResumeContract: Record<string, unknown> = {
    pauseCause: 'needs_decision' as const,
    allowedResumeModes,
    resumePrompt,
    replaceOutputSchema,
    expectedTaskOutputSchema: expectedOutputSchema,
    failedTaskId: task.taskId,
    decisionPrompt: resumePrompt,
    suggestedResumeCall: {
      op: 'workflow.run.resume' as const,
      args: {
        runId,
        resolution:
          humanIntent === 'approve'
            ? { mode: 'replace_output' as const, output: { decision: 'approved' } }
            : { mode: 'replace_output' as const, output: {} },
      },
    },
    pausedTaskInputContract: {
      schema: replaceOutputSchema,
      resolutionMode: 'replace_output' as const,
      prompt: resumePrompt,
    },
  };

  const postBumpPauseVersion = run.pauseVersion + 1;

  let resolvedPreview: ReturnType<typeof resolveActionPreview>['preview'] | undefined;
  if (task.actionPreview) {
    const ctx = await runContextFromDetail(run, deps.payloadStore, deps.db, tenantIdStr);
    const r = resolveActionPreview(task.actionPreview, ctx);
    resolvedPreview = r.preview;
    if (!r.ok) {
      log.warn(
        `[dispatchHumanTask] actionPreview unresolved at pause emit; surfacing raw preview`,
        {
          runId,
          taskId,
          reason: r.reason,
        },
      );
    }
  }

  let displayPreview = resolvedPreview;
  let actionPreviewRef: PayloadRef | undefined;
  if (resolvedPreview && deps.payloadStore.shouldStore(resolvedPreview)) {
    actionPreviewRef = await deps.payloadStore.store({
      tenantId,
      runId: runId as SessionId,
      // Not a real step execution — the action-preview payload only needs a
      // unique key segment. Use a real UUID rather than a `${taskId}:…` string
      // so the StepExecutionId brand is honest (the path never gets re-parsed as
      // a step, but the cast must not lie). actionPreviewRef captures the result.
      stepExecutionId: randomUUID() as StepExecutionId,
      attempt,
      kind: 'output',
      data: resolvedPreview,
    });
    displayPreview = buildDisplayActionPreview(resolvedPreview);
  }

  const hydration = buildHumanTaskHydrationFields({
    task,
    runPauseVersion: postBumpPauseVersion,
    resumeContract: humanResumeContract,
    ...(displayPreview ? { resolvedActionPreview: displayPreview } : {}),
  });

  const durableHydration = buildDurableHydration({
    runId,
    taskId,
    attempt,
    pauseVersion: postBumpPauseVersion,
    humanIntent,
    ...(task.failureMode ? { failureMode: task.failureMode } : {}),
    ...(humanIntent === 'collect' && task.outputContract?.schema
      ? { resolutionSchema: task.outputContract.schema }
      : {}),
    ...(humanIntent === 'approve' && (displayPreview ?? task.actionPreview)
      ? { actionPreview: displayPreview ?? task.actionPreview }
      : {}),
    ...(humanIntent === 'approve' && actionPreviewRef ? { actionPreviewRef } : {}),
    resumeContract: humanResumeContract as never,
  });
  // Decided on the hydration, not on the preview it may contain. The preview is
  // one of several unbounded parts — `resolutionSchema` and `resumeContract` are
  // others — so a hydration can exceed the inline cap with a preview small
  // enough to have ridden inline. The read side is `payloadStore.retrieve`,
  // which resolves either form.
  const hydrationRef = deps.payloadStore.shouldStore(durableHydration)
    ? await deps.payloadStore.store({
        tenantId,
        runId: runId as SessionId,
        stepExecutionId: randomUUID() as StepExecutionId,
        attempt,
        kind: 'state',
        data: durableHydration,
        persist: true,
      })
    : encodeInlineHydrationRef(durableHydration);

  const humanClaimed = await ledgerClaimHumanTask(deps.db, tenantIdStr, {
    runId,
    taskId,
    attempt,
    inputRef: humanInputRef,
    humanTaskHydrationRef: hydrationRef,
    humanTaskHydrationPauseVersion: postBumpPauseVersion,
    humanTaskHydrationAttempt: attempt,
  });
  if (!humanClaimed) {
    log.info(`[dispatchHumanTask] human task already claimed; skipping`);
    return;
  }

  await emitTaskUpdate(deps, {
    tenantId,
    runId,
    taskId,
    label: task.name,
    status: 'paused',
    attempt,
    taskType: 'human',
    completedAt: new Date(),
    ...(hydration ?? {}),
  }).catch((err: unknown) => {
    logOrchestratorError(
      `[dispatchHumanTask] emit WorkflowTaskUpdate(paused) failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
      { tenantId: tenantIdStr, runId, taskId, attempt },
    );
  });

  const contractRef = `inline:${Buffer.from(JSON.stringify(humanResumeContract)).toString('base64')}`;

  await pauseRunOnly(deps, tenantId, runId, taskId, attempt, contractRef, {
    notifyWaiters: false,
    executionState,
  });
}
