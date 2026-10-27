import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import { getSessionWorkflowExecution } from '@aflow/redis';
import type { InlineHandlerArgs } from './types.js';
import { logOrchestratorError } from '../../../../lib/orchestratorLogger.js';

/** Max schedules an agent can create in a single run (safety guardrail) */
export const MAX_SCHEDULE_CREATES_PER_RUN = 10;

/**
 * How long a run's count outlives its last create where no terminal path
 * deleted it — a process that died between the run's terminal write and the
 * delete. Renewed on every create, so a run still creating keeps its count.
 */
export const SCHEDULE_CREATE_COUNT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * The run a create counts against. A workflow task works in a session of its
 * own — an operation task in a synthetic one, an agent task in a worker
 * session — so the session id would give every task a fresh budget; the
 * workflow run the task belongs to is what the limit bounds. A direct run
 * counts against itself.
 */
export async function scheduleBudgetRunId(args: InlineHandlerArgs): Promise<string> {
  if (args.workflowExecution !== undefined) return args.workflowExecution.runId;
  const served = await getSessionWorkflowExecution(
    args.redis,
    args.context.tenantId,
    args.context.runId,
  );
  return served?.runId ?? args.context.runId;
}

/**
 * Counts one create against `runId`; false once its budget is spent. The count
 * lives in Redis rather than this process: a workflow run's tasks run on
 * sessions any orchestrator process may own, and whichever process ends the
 * run is the one that releases it.
 */
export async function claimScheduleCreate(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<boolean> {
  const key = StreamKeys.scheduleCreateCountKey(tenantId, runId);
  const results = await redis
    .multi()
    .incr(key)
    .expire(key, SCHEDULE_CREATE_COUNT_TTL_SECONDS)
    .exec();
  const [incrError, count] = results?.[0] ?? [new Error('no reply'), null];
  if (incrError) throw incrError;
  return Number(count) <= MAX_SCHEDULE_CREATES_PER_RUN;
}

/**
 * Forgets a run's count: called where the run reaches a terminal state. Never
 * throws — a terminal transition does not fail on it, and the TTL ends a count
 * whose delete was lost.
 */
export async function releaseScheduleCreates(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<void> {
  try {
    await redis.del(StreamKeys.scheduleCreateCountKey(tenantId, runId));
  } catch (err) {
    logOrchestratorError("[scheduleCreateBudget] could not release a run's count", err, {
      tenantId,
      runId,
    });
  }
}

/** The count held for `runId`, undefined where none is. */
export async function scheduleCreatesCounted(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<number | undefined> {
  const raw = await redis.get(StreamKeys.scheduleCreateCountKey(tenantId, runId));
  return raw === null ? undefined : Number(raw);
}
