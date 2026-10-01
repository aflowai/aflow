import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type {
  HumanApprovalCall,
  TenantId,
  Workflow,
  WorkflowHumanActionPreview,
} from '@aflow/schemas';
import {
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
   * Given only by the authenticated operator boundary, and called with the
   * call the operator approved before the approval is committed, so whatever
   * that call later needs to prove the decision exists before anything can
   * dispatch it. The agent-driven resume passes none, and so mints nothing.
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
  let merged: Record<string, unknown>;

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
    let resolvedPreview: WorkflowHumanActionPreview | undefined;
    if (taskDef.actionPreview && client.approvedCall === undefined) {
      const ctx = await runContextFromDetail(run, payloadStore, db, tenantIdStr);
      const r = resolveActionPreview(taskDef.actionPreview, ctx);
      if (!r.ok) {
        return {
          ok: false,
          error: {
            code: 'APPROVED_CALL_RESOLUTION_FAILED',
            message: `actionPreview inputBindings could not be resolved at approve time: ${r.reason}. The approval was not persisted.`,
          },
        };
      }
      resolvedPreview = r.preview;
    }
    const approvedCall =
      client.approvedCall ??
      (resolvedPreview ? { op: resolvedPreview.op, input: resolvedPreview.input } : undefined);

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
    if (validateApprove.data.approvedCall && ctx.recordApproval) {
      await ctx.recordApproval(validateApprove.data.approvedCall);
    }
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

  const commitResult = await commitReplaceOutputAndResume(db, tenantIdStr, {
    runId: run.runId,
    claimToken,
    failedTaskId: taskId,
    outputRef: newOutputRef,
    summary: `Resolved via workflow.run.resume replace_output (human ${intent}, pauseVersion=${String(surfaced.pauseVersion)}).`,
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

  return { ok: true, succeededTaskId: taskId };
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
