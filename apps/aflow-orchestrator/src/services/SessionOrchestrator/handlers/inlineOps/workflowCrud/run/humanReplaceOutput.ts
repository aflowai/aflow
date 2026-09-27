import { applyHumanReplaceOutputResolution as applyShared } from '@aflow/cybernetic-runtime';
import type { ApplyHumanReplaceOutputArgs, ApplyReplaceOutputResult } from './resumeTypes.js';

export async function applyHumanReplaceOutputResolution(
  ctx: ApplyHumanReplaceOutputArgs,
): Promise<ApplyReplaceOutputResult> {
  const { args, db, tenantIdStr, run, workflow, surfaced, output, claimToken, actorUserId } = ctx;
  const result = await applyShared({
    db,
    tenantIdStr,
    run,
    workflow,
    surfaced,
    output,
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
  return { ok: true, succeededTaskId: result.succeededTaskId };
}
