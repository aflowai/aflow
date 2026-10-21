import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import type { TenantId, WorkflowRunResumeInput } from '@aflow/schemas';
import {
  executeOperatorWorkflowRunResume,
  enqueueWorkflowHarnessAdvance,
  type OperatorWorkflowRunResumeHarnessHooks,
} from '@aflow/cybernetic-runtime';

export type OperatorResumeResult =
  { ok: true; runId: string } | { ok: false; code: string; message: string };

/**
 * How an operator's resume hands the run back to the orchestrator: the server
 * holds no harness, so each next step is enqueued for the harness-advance
 * consumer.
 */
export function operatorResumeHarnessHooks(
  redis: Redis,
  spaceId: string,
): OperatorWorkflowRunResumeHarnessHooks {
  return {
    applyFailureMode: async (_deps, tenantId, runId, failedTaskId) => {
      await enqueueWorkflowHarnessAdvance(redis, {
        tenantId: tenantId as string,
        workflowRunId: runId,
        spaceId,
        failedTaskId,
      });
    },
    dispatchNextOrTerminate: async (_deps, tenantId, runId) => {
      await enqueueWorkflowHarnessAdvance(redis, {
        tenantId: tenantId as string,
        workflowRunId: runId,
        spaceId,
      });
    },
    dispatchRetriedTask: async (_deps, tenantId, runId, taskId) => {
      await enqueueWorkflowHarnessAdvance(redis, {
        tenantId: tenantId as string,
        workflowRunId: runId,
        spaceId,
        action: 'retry_dispatch',
        taskId,
      });
    },
  };
}

export async function resumeWorkflowRunFromOperatorUi(
  deps: {
    db: PostgresJsDatabase;
    redis: Redis;
    payloadStore: PayloadStore;
  },
  args: {
    tenantId: TenantId;
    spaceId: string;
    userId: string;
    input: WorkflowRunResumeInput;
  },
): Promise<OperatorResumeResult> {
  const result = await executeOperatorWorkflowRunResume(
    deps,
    args,
    operatorResumeHarnessHooks(deps.redis, args.spaceId),
  );

  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  return { ok: true, runId: result.runId };
}
