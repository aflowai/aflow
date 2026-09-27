import { resolveWorkflowForRunRevision } from '@aflow/database';
import type { Workflow } from '@aflow/schemas';
import {
  bumpResumeAttemptCount,
  commitProvideInputAndResume,
  validateParentTaskInputs,
  renderParentInputsValidationFailure,
} from '@aflow/cybernetic-runtime';
import { requireSpaceId } from '../../spaceScope.js';
import type { ApplyProvideInputResolutionArgs, ApplyProvideInputResult } from './resumeTypes.js';

export async function applyProvideInputResolution(
  ctx: ApplyProvideInputResolutionArgs,
): Promise<ApplyProvideInputResult> {
  const { args, db, tenantIdStr, run, taskId, inputs, claimToken } = ctx;
  const spaceId = requireSpaceId(args.context);

  // 1. Verify the named task is actually paused on this run. The
  //    contract's `failedTaskId` may not exist for signal_blocked
  //    pauses, so we trust the resolution.taskId but check it lines up.
  const pausedRow = run.tasks.find((t) => t.status === 'paused' && t.taskId === taskId);
  if (!pausedRow) {
    const pausedTaskIds = run.tasks.filter((t) => t.status === 'paused').map((t) => t.taskId);
    return {
      ok: false,
      error: {
        code: 'PROVIDE_INPUT_TASK_NOT_PAUSED',
        message:
          `Task "${taskId}" is not in 'paused' state on run ${run.runId}. ` +
          (pausedTaskIds.length > 0
            ? `Paused task(s) on this run: [${pausedTaskIds.join(', ')}]. ` +
              'Pass `resolution.taskId` matching one of these.'
            : 'No tasks on this run are paused — nothing to resume with `provide_input`.'),
        // Phase 3 review fix (P2) — structured details mirror Phase 2's
        // start-path codes so the parent can branch on machine-readable
        // fields instead of regex-parsing the prose message.
        details: { taskId, pausedTaskIds },
      },
    };
  }

  // 2. Resolve the workflow definition at the run's pinned revision.
  let workflowDef: Workflow;
  try {
    const resolved = await resolveWorkflowForRunRevision(
      db,
      args.context.tenantId,
      spaceId,
      run.workflowSlug,
      run.workflowRevision,
    );
    workflowDef = resolved.workflow;
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'WORKFLOW_NOT_FOUND',
        message:
          `Workflow ${run.workflowSlug}@${String(run.workflowRevision)} unresolvable: ` +
          (err instanceof Error ? err.message : String(err)),
      },
    };
  }
  const taskDef = workflowDef.tasks.find((t) => t.taskId === taskId);
  if (!taskDef) {
    return {
      ok: false,
      error: {
        code: 'PROVIDE_INPUT_TASK_NOT_IN_WORKFLOW',
        message:
          `Task "${taskId}" is not declared in workflow ${run.workflowSlug}@rev${String(run.workflowRevision)}. ` +
          'The run row may have drifted from the pinned definition; manual recovery required.',
      },
    };
  }

  // 3. Validate parent inputs against the task's input contract
  //    (or accept verbatim if no contract is declared). Phase 3 review
  //    fix (P2): thread structured `details` through so the parent agent
  //    sees the same machine-readable `firstTaskId` / `populatableBindAs`
  //    / `issues` data that Phase 2's `workflow.run.start` boundary
  //    exposes — resume-time self-correction shouldn't be weaker than
  //    start-time self-correction.
  const validation = validateParentTaskInputs(taskDef, inputs, workflowDef.runInputs);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        code: 'PARENT_INPUTS_INVALID',
        message: renderParentInputsValidationFailure(
          taskId,
          validation.issues,
          validation.populatableBindAs,
        ),
        details: {
          firstTaskId: taskId,
          populatableBindAs: validation.populatableBindAs,
          issues: validation.issues,
        },
      },
    };
  }

  // 4. Bump attempt count under the live claim. Same eager-bump pattern
  //    as `replace_output`: failed validations + successes both count
  //    toward the cap once we're past the validators above.
  const postBump = await bumpResumeAttemptCount(db, tenantIdStr, run.runId, claimToken);
  if (postBump === null) {
    return {
      ok: false,
      error: {
        code: 'RESUME_COMMIT_LOST',
        message: 'Resume lease expired before commit. Re-fetch the surfaced contract and retry.',
      },
    };
  }

  // 5. Atomic commit — run row + metadata merge + paused task row delete.
  const commitResult = await commitProvideInputAndResume(db, tenantIdStr, {
    runId: run.runId,
    claimToken,
    taskId,
    parentTaskInputs: { taskId, inputs: validation.validatedInputs },
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
  if (commitResult === 'task_row_not_paused') {
    return {
      ok: false,
      error: {
        code: 'PROVIDE_INPUT_TASK_NOT_PAUSED',
        message:
          `Task "${taskId}" on run ${run.runId} was not in 'paused' state at commit time. ` +
          'A concurrent path may have reprocessed it. Re-fetch the surfaced contract.',
      },
    };
  }
  return { ok: true };
}
