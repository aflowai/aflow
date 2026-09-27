import { applyFailTaskResolution as applyShared } from '@aflow/cybernetic-runtime';
import type { ApplyFailTaskResolutionArgs, ApplyFailTaskResult } from './resumeTypes.js';

export async function applyFailTaskResolution(
  ctx: ApplyFailTaskResolutionArgs,
): Promise<ApplyFailTaskResult> {
  const result = await applyShared({
    db: ctx.db,
    tenantIdStr: ctx.tenantIdStr,
    run: ctx.run,
    surfaced: ctx.surfaced,
    reason: ctx.reason,
    claimToken: ctx.claimToken,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return {
    ok: true,
    failedTaskId: result.failedTaskId,
    workflow: ctx.workflow,
    taskId: result.failedTaskId,
  };
}
