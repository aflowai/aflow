/** Operator/agent rejection of an approval gate — thin wrapper over the shared handler. */
import { applyRejectResolution as applyShared } from '@aflow/cybernetic-runtime';
import type { ApplyRejectResolutionArgs, ApplyRejectResult } from './resumeTypes.js';

export async function applyRejectResolution(
  ctx: ApplyRejectResolutionArgs,
): Promise<ApplyRejectResult> {
  const { args, db, tenantIdStr, run, workflow, surfaced, comment, claimToken, actorUserId } = ctx;
  const result = await applyShared({
    db,
    tenantIdStr,
    run,
    workflow,
    surfaced,
    ...(comment ? { comment } : {}),
    claimToken,
    actorUserId,
    payloadStore: args.payloadStore,
    storeContext: {
      tenantId: args.context.tenantId,
      runId: run.runId,
      stepExecutionId: args.stepExecutionId,
      attempt: args.attempt,
    },
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return {
    ok: true,
    skippedTaskId: result.skippedTaskId,
    skippedDescendantTaskIds: result.skippedDescendantTaskIds,
  };
}
