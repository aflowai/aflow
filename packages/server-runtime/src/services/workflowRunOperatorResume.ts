import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import type { TenantId, WorkflowRunResumeInput } from '@aflow/schemas';
import {
  executeOperatorWorkflowRunResume,
  enqueueWorkflowHarnessAdvance,
} from '@aflow/cybernetic-runtime';

export type OperatorResumeResult =
  { ok: true; runId: string } | { ok: false; code: string; message: string };

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
  const result = await executeOperatorWorkflowRunResume(deps, args, {
    applyFailureMode: async (_deps, tenantId, runId, failedTaskId) => {
      await enqueueWorkflowHarnessAdvance(deps.redis, {
        tenantId: tenantId as string,
        workflowRunId: runId,
        spaceId: args.spaceId,
        failedTaskId,
      });
    },
    dispatchNextOrTerminate: async (_deps, tenantId, runId) => {
      await enqueueWorkflowHarnessAdvance(deps.redis, {
        tenantId: tenantId as string,
        workflowRunId: runId,
        spaceId: args.spaceId,
      });
    },
    dispatchRetriedTask: async (_deps, tenantId, runId, taskId) => {
      await enqueueWorkflowHarnessAdvance(deps.redis, {
        tenantId: tenantId as string,
        workflowRunId: runId,
        spaceId: args.spaceId,
        action: 'retry_dispatch',
        taskId,
      });
    },
  });

  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  return { ok: true, runId: result.runId };
}
