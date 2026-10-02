import { isDeepStrictEqual } from 'node:util';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { HostApprovedPush, HumanApprovalCall, TenantId, Workflow } from '@aflow/schemas';
import {
  HostApprovedPushSchema,
  HumanApprovalOutputSchema,
  HumanApprovalResolutionInputSchema,
  inferTaskType,
  type SessionId,
  type StepExecutionId,
} from '@aflow/schemas';
import type { WorkflowRunDetail } from './ledger.js';
import {
  bumpResumeAttemptCount,
  commitReplaceOutputAndResume,
  commitFailTaskAndResume,
  commitRejectApproveTaskAndResume,
} from './ledger.js';
import { getResumeAjv } from './resumeAjv.js';
import { computeRejectedApprovalSkipSet } from './scheduling/graph.js';
import type { SurfacedResumeContract } from './workflowResume.js';
import { resolveActionPreview, runContextFromDetail } from './humanTaskHydration.js';

export interface ResumeModeError {
  code: string;
  message: string;
}

export type ApplyReplaceOutputModeResult =
  { ok: true; succeededTaskId: string } | { ok: false; error: ResumeModeError };

export type ApplyFailTaskModeResult =
  { ok: true; failedTaskId: string } | { ok: false; error: ResumeModeError };

export type ApplyRejectTaskModeResult =
  | { ok: true; skippedTaskId: string; skippedDescendantTaskIds: string[] }
  | { ok: false; error: ResumeModeError };

export interface HumanReplaceOutputContext {
  db: PostgresJsDatabase;
  tenantIdStr: string;
  run: WorkflowRunDetail;
  workflow: Workflow;
  surfaced: SurfacedResumeContract | null;
  output: unknown;
  claimToken: string;
  actorUserId: string;
  payloadStore: PayloadStore;
  /**
   * Given only by the authenticated operator boundary, so its absence is what
   * marks a resolver that is not the operator. Called within the approval's
   * commit, once the run and task rows have passed their checks, and only for
   * a task that declares `actionPreview`, with the call the server resolved
   * from it — an approval that never lands, or one whose call came from the
   * client alone, leaves nothing behind, and a throw rolls the approval back.
   */
  recordApproval?: (approvedCall: HumanApprovalCall) => Promise<void>;
  storeContext: {
    tenantId: TenantId;
    runId: string;
    stepExecutionId: string;
    attempt: number;
  };
}

export async function applyHumanReplaceOutputResolution(
  ctx: HumanReplaceOutputContext,
): Promise<ApplyReplaceOutputModeResult> {
  const {
    db,
    tenantIdStr,
    run,
    workflow,
    surfaced,
    output,
    claimToken,
    actorUserId,
    payloadStore,
    storeContext,
  } = ctx;

  if (!surfaced?.contract.failedTaskId) {
    return {
      ok: false,
      error: {
        code: 'RESUME_CONTRACT_MISSING_TASK',
        message: 'Surfaced resume contract has no failedTaskId.',
      },
    };
  }

  const taskId = surfaced.contract.failedTaskId;
  const taskDef = workflow.tasks.find((t) => t.taskId === taskId);
  if (!taskDef || inferTaskType(taskDef) !== 'human') {
    return {
      ok: false,
      error: {
        code: 'HUMAN_TASK_NOT_FOUND',
        message: `Task "${taskId}" is not a human workflow task.`,
      },
    };
  }

  const intent = taskDef.intent ?? 'collect';
  const previewResolution =
    intent === 'approve' && taskDef.actionPreview
      ? resolveActionPreview(
          taskDef.actionPreview,
          await runContextFromDetail(run, payloadStore, db, tenantIdStr),
        )
      : undefined;

  // Decided before the attempt is counted: this refusal leaves the pause as it
  // was, so it must not spend an attempt the operator's own approve needs.
  if (intent === 'approve' && !ctx.recordApproval) {
    const parsedClient = HumanApprovalResolutionInputSchema.safeParse(output);
    const call = taskDef.actionPreview
      ? previewResolution?.ok
        ? { op: previewResolution.preview.op, input: previewResolution.preview.input }
        : undefined
      : parsedClient.success
        ? parsedClient.data.approvedCall
        : undefined;
    const push = call ? hostPushOf(call) : undefined;
    if (push) {
      return {
        ok: false,
        error: {
          code: 'PUSH_APPROVAL_OPERATOR_ONLY',
          message:
            `This approval would let \`${push.refspec}\` be pushed from \`${push.bindingId}\`, ` +
            "and a push's approval is the operator's to give: one given here would be recorded " +
            'and the push still refused. Nothing was approved and no resume attempt was spent; ' +
            'the task is still paused and its card in the Action Center is still live for the ' +
            'operator.',
        },
      };
    }
  }

  const postBump = await bumpResumeAttemptCount(db, tenantIdStr, run.runId, claimToken);
  if (postBump === null) {
    return {
      ok: false,
      error: {
        code: 'RESUME_COMMIT_LOST',
        message:
          'Resume lease expired before mode work could begin. Re-fetch the surfaced contract and retry.',
      },
    };
  }

  let merged: Record<string, unknown>;
  let grantableCall: HumanApprovalCall | undefined;

  if (intent === 'approve') {
    const parsedClient = HumanApprovalResolutionInputSchema.safeParse(output);
    if (!parsedClient.success) {
      return {
        ok: false,
        error: {
          code: 'REPLACE_OUTPUT_INVALID',
          message:
            'Approval resolution must be { decision: "approved", comment?, approvedCall? }. ' +
            'To reject, use mode "reject" (skips the gated branch, reject-but-learn); mode "fail" ' +
            'is reserved for a genuine approve-task failure that should block descendants.',
        },
      };
    }
    const client = parsedClient.data;
    let approvedCall: HumanApprovalCall | undefined = client.approvedCall;
    if (previewResolution) {
      const r = previewResolution;
      if (!r.ok) {
        return {
          ok: false,
          error: {
            code: 'APPROVED_CALL_RESOLUTION_FAILED',
            message: `actionPreview inputBindings could not be resolved at approve time: ${r.reason}. The approval was not persisted.`,
          },
        };
      }
      const resolvedCall: HumanApprovalCall = { op: r.preview.op, input: r.preview.input };
      if (client.approvedCall !== undefined) {
        const differing = approvedCallDifferences(client.approvedCall, resolvedCall);
        if (differing.length > 0) {
          return {
            ok: false,
            error: {
              code: 'APPROVED_CALL_MISMATCH',
              message:
                'The approvedCall sent differs from the call this task previews, at ' +
                `${describeDifferences(differing)}. The call approved is the task's preview as ` +
                'the server resolves it now: approve without approvedCall, or send that call ' +
                'unchanged. The approval was not persisted.',
            },
          };
        }
      }
      approvedCall = resolvedCall;
    }

    // Belt-and-suspenders: when the task declared actionPreview, approvedCall must materialize
    // AND `.input` must be defined. The schema allows `input` optional (legacy literal-input
    // path) but for this code path we require it to be present so downstream ops bind to real
    // values, not undefined.
    if (taskDef.actionPreview && approvedCall?.input === undefined) {
      return {
        ok: false,
        error: {
          code: 'APPROVED_CALL_REQUIRED',
          message:
            'This approval task has an actionPreview but approvedCall could not be materialized with a defined input. The approval was not persisted.',
        },
      };
    }

    merged = {
      decision: 'approved' as const,
      ...(client.comment ? { comment: client.comment } : {}),
      decidedAt: new Date().toISOString(),
      decidedBy: actorUserId,
      ...(approvedCall ? { approvedCall } : {}),
    };

    const validateApprove = HumanApprovalOutputSchema.safeParse(merged);
    if (!validateApprove.success) {
      return {
        ok: false,
        error: {
          code: 'REPLACE_OUTPUT_VALIDATION_FAILED',
          message: validateApprove.error.message,
        },
      };
    }
    if (taskDef.actionPreview && !validateApprove.data.approvedCall) {
      return {
        ok: false,
        error: {
          code: 'APPROVED_CALL_REQUIRED',
          message: 'approvedCall is required when the task declares actionPreview.',
        },
      };
    }
    if (taskDef.actionPreview) grantableCall = validateApprove.data.approvedCall;
  } else {
    const schema =
      taskDef.outputContract?.schema ??
      surfaced.contract.replaceOutputSchema ??
      surfaced.contract.expectedTaskOutputSchema;
    if (!schema || typeof schema !== 'object') {
      return {
        ok: false,
        error: {
          code: 'RESUME_CONTRACT_NO_SCHEMA',
          message: 'Collect human task has no output schema to validate against.',
        },
      };
    }
    if (
      output === undefined ||
      output === null ||
      typeof output !== 'object' ||
      Array.isArray(output)
    ) {
      return {
        ok: false,
        error: {
          code: 'REPLACE_OUTPUT_INVALID',
          message: 'collect resolution output must be a JSON object.',
        },
      };
    }
    merged = output as Record<string, unknown>;
    const ajv = getResumeAjv();
    const validate = ajv.compile(schema);
    if (!validate(merged)) {
      const issues =
        (validate as unknown as { errors?: Array<{ instancePath: string; message?: string }> })
          .errors ?? [];
      const summary = issues
        .slice(0, 5)
        .map((i) => `${i.instancePath || '<root>'}: ${i.message ?? 'invalid'}`)
        .join('; ');
      return {
        ok: false,
        error: {
          code: 'REPLACE_OUTPUT_VALIDATION_FAILED',
          message: `Output failed validation: ${summary}`,
        },
      };
    }
  }

  const newOutputRef = await payloadStore.store({
    tenantId: storeContext.tenantId,
    runId: storeContext.runId as SessionId,
    stepExecutionId: storeContext.stepExecutionId as StepExecutionId,
    attempt: storeContext.attempt,
    kind: 'output',
    data: merged,
    contentType: 'application/json',
  });

  const { recordApproval } = ctx;
  const commitResult = await commitReplaceOutputAndResume(db, tenantIdStr, {
    runId: run.runId,
    claimToken,
    failedTaskId: taskId,
    outputRef: newOutputRef,
    summary: `Resolved via workflow.run.resume replace_output (human ${intent}, pauseVersion=${String(surfaced.pauseVersion)}).`,
    ...(grantableCall && recordApproval
      ? { recordWithinCommit: () => recordApproval(grantableCall) }
      : {}),
  });

  if (commitResult === 'claim_lost') {
    return {
      ok: false,
      error: {
        code: 'RESUME_COMMIT_LOST',
        message:
          'Resume lease expired or was superseded between validation and commit. Re-fetch the surfaced contract and retry.',
      },
    };
  }
  if (commitResult === 'task_row_not_paused') {
    return {
      ok: false,
      error: {
        code: 'RESUME_TASK_ROW_NOT_PAUSED',
        message: `Task "${taskId}" is not paused — commit rolled back.`,
      },
    };
  }
  if (commitResult === 'record_failed') {
    return {
      ok: false,
      error: {
        code: 'APPROVAL_NOT_RECORDED',
        message:
          `The approval of task "${taskId}" could not be recorded, so it was not applied: the ` +
          'task is still paused and the run has not moved. Approve it again.',
      },
    };
  }

  return { ok: true, succeededTaskId: taskId };
}

/** The push a call approves, when it is a `host.process.exec` push. */
export function hostPushOf(call: HumanApprovalCall): HostApprovedPush | undefined {
  if (call.op !== 'host.process.exec') return undefined;
  const push = HostApprovedPushSchema.safeParse(call.input);
  return push.success ? push.data : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where `sent` departs from `resolved`, as paths; empty when they are deep-equal. */
function approvedCallDifferences(sent: unknown, resolved: unknown, at = ''): string[] {
  if (isRecord(sent) && isRecord(resolved)) {
    const keys = [...new Set([...Object.keys(sent), ...Object.keys(resolved)])].sort();
    return keys.flatMap((key) =>
      approvedCallDifferences(sent[key], resolved[key], at === '' ? key : `${at}.${key}`),
    );
  }
  if (Array.isArray(sent) && Array.isArray(resolved) && sent.length === resolved.length) {
    return sent.flatMap((item, index) =>
      approvedCallDifferences(item, resolved[index], `${at}[${String(index)}]`),
    );
  }
  return isDeepStrictEqual(sent, resolved) ? [] : [at === '' ? '<root>' : at];
}

const DIFFERENCES_NAMED = 8;

function describeDifferences(paths: readonly string[]): string {
  const named = paths
    .slice(0, DIFFERENCES_NAMED)
    .map((path) => `\`${path}\``)
    .join(', ');
  const more = paths.length - DIFFERENCES_NAMED;
  return more > 0 ? `${named} and ${String(more)} more` : named;
}

export async function applyFailTaskResolution(ctx: {
  db: PostgresJsDatabase;
  tenantIdStr: string;
  run: WorkflowRunDetail;
  surfaced: SurfacedResumeContract | null;
  reason: string;
  claimToken: string;
}): Promise<ApplyFailTaskModeResult> {
  const { db, tenantIdStr, run, surfaced, reason, claimToken } = ctx;

  if (!surfaced) {
    return {
      ok: false,
      error: {
        code: 'RESUME_CONTRACT_MISSING',
        message: 'No structured resume contract is attached to this pause.',
      },
    };
  }

  const taskId = surfaced.contract.failedTaskId;
  if (!taskId) {
    return {
      ok: false,
      error: {
        code: 'RESUME_CONTRACT_MISSING_TASK',
        message: 'Surfaced resume contract has no failedTaskId.',
      },
    };
  }

  const taskRow = run.tasks.find((t) => t.taskId === taskId && t.status === 'paused');
  if (!taskRow) {
    return {
      ok: false,
      error: {
        code: 'RESUME_TASK_ROW_NOT_PAUSED',
        message: `Task "${taskId}" is not paused on run ${run.runId}.`,
      },
    };
  }

  const commitResult = await commitFailTaskAndResume(db, tenantIdStr, {
    runId: run.runId,
    claimToken,
    taskId,
    attempt: taskRow.attempt,
    reason,
    summary: `Rejected via workflow.run.resume fail (pauseVersion=${String(surfaced.pauseVersion)}).`,
  });

  if (commitResult === 'claim_lost') {
    return {
      ok: false,
      error: {
        code: 'RESUME_COMMIT_LOST',
        message:
          'Resume lease expired or was superseded between claim and commit. Re-fetch the surfaced contract and retry.',
      },
    };
  }
  if (commitResult === 'task_row_state_mismatch') {
    return {
      ok: false,
      error: {
        code: 'RESUME_TASK_ROW_STATE_MISMATCH',
        message: `Task "${taskId}" is not in the expected paused state — commit rolled back. Re-fetch the contract.`,
      },
    };
  }

  return { ok: true, failedTaskId: taskId };
}

/**
 * `reject` resolution — an operator's "no" on an approval gate (reject-but-learn).
 *
 * Marks the approve task and its `when`-gated descendant branch **skipped**
 * (not failed/blocked), records the rejected decision as the approve task's
 * output, and flips the run back to `running`. The caller then drives
 * `dispatchNextOrTerminate`, which dispatches the approve task's always-on
 * (when-less) descendants — their bindings to the skipped branch resolve to
 * ABSENT. See `computeRejectedApprovalSkipSet`.
 */
export async function applyRejectResolution(ctx: {
  db: PostgresJsDatabase;
  tenantIdStr: string;
  run: WorkflowRunDetail;
  workflow: Workflow;
  surfaced: SurfacedResumeContract | null;
  comment?: string;
  claimToken: string;
  actorUserId: string;
  payloadStore: PayloadStore;
  storeContext: {
    tenantId: TenantId;
    runId: string;
    stepExecutionId: string;
    attempt: number;
  };
}): Promise<ApplyRejectTaskModeResult> {
  const {
    db,
    tenantIdStr,
    run,
    workflow,
    surfaced,
    comment,
    claimToken,
    actorUserId,
    payloadStore,
    storeContext,
  } = ctx;

  if (!surfaced) {
    return {
      ok: false,
      error: {
        code: 'RESUME_CONTRACT_MISSING',
        message: 'No structured resume contract is attached to this pause.',
      },
    };
  }

  const taskId = surfaced.contract.failedTaskId;
  if (!taskId) {
    return {
      ok: false,
      error: {
        code: 'RESUME_CONTRACT_MISSING_TASK',
        message: 'Surfaced resume contract has no failedTaskId.',
      },
    };
  }

  const taskDef = workflow.tasks.find((t) => t.taskId === taskId);
  if (!taskDef || inferTaskType(taskDef) !== 'human') {
    return {
      ok: false,
      error: {
        code: 'HUMAN_TASK_NOT_FOUND',
        message: `Task "${taskId}" is not a human workflow task — reject only applies to approval gates.`,
      },
    };
  }

  const taskRow = run.tasks.find((t) => t.taskId === taskId && t.status === 'paused');
  if (!taskRow) {
    return {
      ok: false,
      error: {
        code: 'RESUME_TASK_ROW_NOT_PAUSED',
        message: `Task "${taskId}" is not paused on run ${run.runId}.`,
      },
    };
  }

  const rejectedOutput = {
    decision: 'rejected' as const,
    decidedAt: new Date().toISOString(),
    decidedBy: actorUserId,
    ...(comment ? { comment } : {}),
  };
  const outputRef = await payloadStore.store({
    tenantId: storeContext.tenantId,
    runId: storeContext.runId as SessionId,
    stepExecutionId: storeContext.stepExecutionId as StepExecutionId,
    attempt: storeContext.attempt,
    kind: 'output',
    data: rejectedOutput,
    contentType: 'application/json',
  });

  const skipSet = computeRejectedApprovalSkipSet(workflow.tasks, taskId);
  const skipDescendantTaskIds = [...skipSet].filter((id) => id !== taskId);

  const commitResult = await commitRejectApproveTaskAndResume(db, tenantIdStr, {
    runId: run.runId,
    claimToken,
    taskId,
    attempt: taskRow.attempt,
    outputRef,
    skipDescendantTaskIds,
    summary: `Rejected via workflow.run.resume reject (gated branch skipped, pauseVersion=${String(surfaced.pauseVersion)}).`,
  });

  if (commitResult === 'claim_lost') {
    return {
      ok: false,
      error: {
        code: 'RESUME_COMMIT_LOST',
        message:
          'Resume lease expired or was superseded between claim and commit. Re-fetch the surfaced contract and retry.',
      },
    };
  }
  if (commitResult === 'task_row_state_mismatch') {
    return {
      ok: false,
      error: {
        code: 'RESUME_TASK_ROW_STATE_MISMATCH',
        message: `Task "${taskId}" is not in the expected paused state — commit rolled back. Re-fetch the contract.`,
      },
    };
  }

  return { ok: true, skippedTaskId: taskId, skippedDescendantTaskIds: skipDescendantTaskIds };
}
