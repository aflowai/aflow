import { getDatabase } from '@aflow/database';
import type { WorkflowRunCancelInput, WorkflowRunCancelOutput } from '@aflow/schemas';
import { loadRunById } from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from '../../types.js';
import { emitStepSuccess, emitStepError } from '../../helpers.js';
import { requireSpaceId } from '../../spaceScope.js';

export async function handleWorkflowRunCancel(
  args: InlineHandlerArgs,
  input: WorkflowRunCancelInput,
  startTime: number,
): Promise<void> {
  const spaceId = requireSpaceId(args.context);
  const db = getDatabase();
  const tenantIdStr = args.context.tenantId as string;

  const run = await loadRunById(db, tenantIdStr, spaceId, input.runId);
  if (!run) {
    await emitStepError(
      args,
      'WORKFLOW_RUN_NOT_FOUND',
      `No workflow run found with id "${input.runId}" in this space.`,
      startTime,
      'validation',
    );
    return;
  }
  if (run.status === 'cancelled' || run.status === 'completed' || run.status === 'failed') {
    await emitStepError(
      args,
      'WORKFLOW_RUN_ALREADY_TERMINAL',
      `Workflow run "${input.runId}" is already in terminal status "${run.status}".`,
      startTime,
      'validation',
    );
    return;
  }

  const { cancelRun, CancelCascadeDeliveryError } =
    await import('../../../../../cybernetic/WorkflowRunHarness.js');
  let result;
  try {
    result = await cancelRun(
      { db, redis: args.redis, payloadStore: args.payloadStore },
      args.context.tenantId,
      run.runId,
      {
        cancelledBy: 'agent',
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
    );
  } catch (err) {
    if (err instanceof CancelCascadeDeliveryError) {
      await emitStepError(
        args,
        'CANCEL_CASCADE_DELIVERY_FAILED',
        `Cancel could not deliver cancel_run to ${String(err.failedCount)} session(s); ` +
          `the run remains running and the workflow_run_completion_pending rows are intact ` +
          `for retry. Call workflow.run.cancel again. Detail: ${err.summary}`,
        startTime,
        'transient',
      );
      return;
    }
    throw err;
  }

  const output: WorkflowRunCancelOutput = {
    runId: run.runId,
    status: 'cancelled',
    cancelledAt: result.cancelledAt.toISOString(),
    cancelledTaskIds: result.cancelledTaskIds,
    interruptedSessions: result.interruptedSessions,
  };
  await emitStepSuccess(args, output as unknown as Record<string, unknown>, startTime);
}
