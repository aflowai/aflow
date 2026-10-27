import { getSessionWorkflowExecution } from '@aflow/redis';
import type { InlineHandlerArgs } from './types.js';

/** Max schedules an agent can create in a single run (safety guardrail) */
export const MAX_SCHEDULE_CREATES_PER_RUN = 10;

/**
 * Creates counted per owning run, released when that run ends. Held by this
 * process: a workflow run whose tasks run on sessions another orchestrator
 * instance owns is bounded per instance.
 */
const createsByRun = new Map<string, number>();

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

/** Counts one create against `runId`; false, counting nothing, once its budget is spent. */
export function claimScheduleCreate(runId: string): boolean {
  const count = createsByRun.get(runId) ?? 0;
  if (count >= MAX_SCHEDULE_CREATES_PER_RUN) return false;
  createsByRun.set(runId, count + 1);
  return true;
}

/** Forgets a run's count: called where the run reaches a terminal state. */
export function releaseScheduleCreates(runId: string): void {
  createsByRun.delete(runId);
}

/** The count held for `runId`, undefined where none is. */
export function scheduleCreatesCounted(runId: string): number | undefined {
  return createsByRun.get(runId);
}
