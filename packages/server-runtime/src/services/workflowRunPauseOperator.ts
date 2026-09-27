import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import type { TenantId, WorkflowRunPauseInput, WorkflowRunPauseOutput } from '@aflow/schemas';
import { executeOperatorWorkflowRunPause } from '@aflow/cybernetic-runtime';

export type OperatorPauseResult =
  { ok: true; output: WorkflowRunPauseOutput } | { ok: false; code: string; message: string };

export async function pauseWorkflowRunFromOperatorUi(
  deps: {
    db: PostgresJsDatabase;
    redis: Redis;
    payloadStore: PayloadStore;
  },
  args: {
    tenantId: TenantId;
    spaceId: string;
    userId: string;
    input: WorkflowRunPauseInput;
  },
): Promise<OperatorPauseResult> {
  return executeOperatorWorkflowRunPause(deps, args);
}
