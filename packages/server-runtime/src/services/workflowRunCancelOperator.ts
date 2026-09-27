import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import type {
  TenantId,
  WorkflowRunCancelOperatorInput,
  WorkflowRunCancelOperatorOutput,
} from '@aflow/schemas';
import { loadRunById, enqueueWorkflowHarnessAdvance } from '@aflow/cybernetic-runtime';

export type OperatorCancelResult =
  | { ok: true; output: WorkflowRunCancelOperatorOutput }
  | { ok: false; code: string; message: string };

export async function cancelWorkflowRunFromOperatorUi(
  deps: {
    db: PostgresJsDatabase;
    redis: Redis;
    payloadStore: PayloadStore;
  },
  args: {
    tenantId: TenantId;
    spaceId: string;
    userId: string;
    input: WorkflowRunCancelOperatorInput;
  },
): Promise<OperatorCancelResult> {
  const tenantIdStr = args.tenantId as string;
  const { runId } = args.input;

  const run = await loadRunById(deps.db, tenantIdStr, args.spaceId, runId);
  if (!run) {
    return {
      ok: false,
      code: 'WORKFLOW_RUN_NOT_FOUND',
      message: `No workflow run "${runId}" in this space.`,
    };
  }
  if (run.status === 'cancelled' || run.status === 'completed' || run.status === 'failed') {
    return {
      ok: false,
      code: 'WORKFLOW_RUN_ALREADY_TERMINAL',
      message: `Run "${runId}" is already ${run.status}; only a running or paused run can be cancelled.`,
    };
  }

  await enqueueWorkflowHarnessAdvance(deps.redis, {
    tenantId: tenantIdStr,
    workflowRunId: runId,
    spaceId: args.spaceId,
    action: 'cancel',
    // Operator-cancel legibility: this route is the operator's deliberate
    // stop. The worker threads the actor into `cancelRun` so the terminal
    // state + the parked Helmsman's wake-up envelope distinguish it from a
    // platform failure (no auto-retry).
    cancelledBy: 'operator',
    ...(args.input.reason !== undefined ? { reason: args.input.reason } : {}),
  });

  return { ok: true, output: { runId, status: 'cancelling' } };
}
