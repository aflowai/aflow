import {
  computeBlockedDescendantsToClearForRetry,
  RETRY_FAILED_TASK_DEFAULT_MAX_ATTEMPTS,
  bumpResumeAttemptCount,
  commitReExecutePausedTaskAndResume,
} from '@aflow/cybernetic-runtime';
import { inferTaskType, normalizeInstructionsForStorage, type WorkflowTask } from '@aflow/schemas';
import type { ApplyReExecuteResolutionArgs, ApplyReExecuteResult } from './resumeTypes.js';

function instructionsTargetMismatch(
  instructions: ApplyReExecuteResolutionArgs['instructions'],
  taskId: string,
): boolean {
  if (instructions === undefined) return false;
  if (typeof instructions === 'string') return false;
  // per-task — every entry must match the targeted task.
  return instructions.some((entry) => entry.taskId !== taskId);
}

export async function applyReExecuteResolution(
  ctx: ApplyReExecuteResolutionArgs,
): Promise<ApplyReExecuteResult> {
  const {
    db,
    tenantIdStr,
    run,
    workflow,
    surfaced,
    instructions,
    remediationConfirmed,
    claimToken,
  } = ctx;

  // 1. Surfaced contract must exist and name the failed task — same
  //    guard the other task-row modes (replace_output, fail) use.
  if (!surfaced) {
    return {
      ok: false,
      error: {
        code: 'RESUME_CONTRACT_MISSING',
        message:
          'No structured resume contract is attached to this pause. `re_execute` requires a contract that names the paused task.',
      },
    };
  }
  const failedTaskId = surfaced.contract.failedTaskId;
  if (!failedTaskId) {
    return {
      ok: false,
      error: {
        code: 'RESUME_CONTRACT_MISSING_TASK',
        message:
          'Surfaced resume contract has no `failedTaskId` — cannot route `re_execute` to a specific task row.',
      },
    };
  }

  // 2. Resolve the task definition — required for retryability, maxAttempts,
  //    and type checks (human tasks have their own resume modes).
  const taskDef: WorkflowTask | undefined = workflow.tasks.find((t) => t.taskId === failedTaskId);
  if (!taskDef) {
    return {
      ok: false,
      error: {
        code: 'RE_EXECUTE_TASK_NOT_IN_WORKFLOW',
        message:
          `Task "${failedTaskId}" is not declared in workflow ${run.workflowSlug}@rev${String(run.workflowRevision)}. ` +
          'The pinned workflow definition may have drifted; refresh the contract or cancel the run.',
      },
    };
  }
  if (inferTaskType(taskDef) === 'human') {
    return {
      ok: false,
      error: {
        code: 'RE_EXECUTE_HUMAN_TASK_NOT_SUPPORTED',
        message:
          `Task "${failedTaskId}" is a human task. \`re_execute\` is only valid for agent / operation tasks; ` +
          'use `replace_output` (approve) or `fail` (reject) instead.',
      },
    };
  }

  const retryability = taskDef.retryability ?? 'unknown';
  if (retryability !== 'safe' && remediationConfirmed !== true) {
    return {
      ok: false,
      error: {
        code: 'RE_EXECUTE_UNSAFE_TASK_REQUIRES_CONFIRMATION',
        message:
          `Task "${failedTaskId}" is declared \`retryability: '${retryability}'\` — side effects ` +
          'may have occurred on the prior attempt. Pass `remediationConfirmed: true` on the ' +
          'resolution after verifying external state with the operator.',
      },
    };
  }

  // 4. Per-task `instructions` must target the same task we're retrying;
  //    a mismatch is almost always Helmsman pointing at the wrong task and
  //    would silently miss the new attempt otherwise.
  if (instructionsTargetMismatch(instructions, failedTaskId)) {
    return {
      ok: false,
      error: {
        code: 'RE_EXECUTE_INSTRUCTIONS_TASK_MISMATCH',
        message:
          `re_execute targets task "${failedTaskId}" but \`instructions[].taskId\` references ` +
          'a different task. Use a single per-task entry matching the retried task, or use ' +
          'the run-level string form.',
      },
    };
  }

  // 5. Budget gate — happens BEFORE the lease/claim work. Mirrors
  //    `retry_failed_task` (`retryFailedTask.ts:60`): if the current
  //    attempt would push past maxAttempts, refuse without consuming
  //    the claim. The original contract stays intact for the operator
  //    to pick a different mode (`fail`, or wait for the rerun-lane
  //    path to convert to `retry_budget_exceeded`).
  const failedRow = run.tasks.find((t) => t.taskId === failedTaskId);
  if (!failedRow) {
    return {
      ok: false,
      error: {
        code: 'RE_EXECUTE_TASK_ROW_MISSING',
        message: `No task row found for "${failedTaskId}" on run ${run.runId}.`,
      },
    };
  }
  if (failedRow.status !== 'paused') {
    return {
      ok: false,
      error: {
        code: 'RE_EXECUTE_TASK_NOT_PAUSED',
        message:
          `Task "${failedTaskId}" is "${failedRow.status}" — re_execute only resets paused rows. ` +
          'A concurrent path may have advanced it; refresh the contract.',
      },
    };
  }
  const maxAttempts = taskDef.maxAttempts ?? RETRY_FAILED_TASK_DEFAULT_MAX_ATTEMPTS;
  if (failedRow.attempt >= maxAttempts) {
    return {
      ok: false,
      error: {
        code: 'RETRY_ATTEMPT_BUDGET_EXHAUSTED',
        message:
          `Task "${failedTaskId}" retry budget exhausted: attempt=${String(failedRow.attempt)} >= maxAttempts=${String(maxAttempts)}. ` +
          'Pick `fail` to mark the task failed, or cancel the run.',
      },
    };
  }

  // 6. Bump the resume-attempt counter under the live claim. Mirrors
  //    `replace_output` / `provide_input`'s eager-bump pattern: failed
  //    validations + successes alike count toward the cap on the run.
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

  // 7. Atomic commit — run row + task row + optional instructions merge.
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
    ...computeBlockedDescendantsToClearForRetry(workflow.tasks, run.tasks, failedTaskId),
  ];

  const commitResult = await commitReExecutePausedTaskAndResume(db, tenantIdStr, {
    runId: run.runId,
    claimToken,
    taskId: failedTaskId,
    expectedAttempt: failedRow.attempt,
    descendantTaskIds,
    ...(remediationNote ? { remediationNote } : {}),
    ...(parentInstructionsPatch ? { parentInstructionsPatch } : {}),
  });

  if (commitResult === 'claim_lost') {
    return {
      ok: false,
      error: {
        code: 'RESUME_COMMIT_LOST',
        message:
          'Resume lease expired or was superseded between validation and commit. ' +
          'Re-fetch the surfaced contract and retry.',
      },
    };
  }
  if (commitResult === 'at_parallel_limit') {
    return {
      ok: false,
      error: {
        code: 'RESUME_AT_PARALLEL_LIMIT',
        message:
          `Run ${run.runId} is at its parallel-task limit, so re-executing "${failedTaskId}" would ` +
          'put it over. Wait for an in-flight task to finish and resume again — nothing changed.',
      },
    };
  }
  if (commitResult === 'task_row_not_paused') {
    return {
      ok: false,
      error: {
        code: 'RESUME_TASK_ROW_NOT_PAUSED',
        message:
          `Task "${failedTaskId}" on run ${run.runId} was not in 'paused' state at commit time ` +
          '(another path advanced it). Re-fetch the surfaced contract.',
      },
    };
  }
  return {
    ok: true,
    retriedTaskId: failedTaskId,
    retriedAttempt: failedRow.attempt + 1,
  };
}
