/**
 * A run serving a plan node leaves its record on the node as it ends (Plan
 * 322 D5): the run itself, and the pull request its promoted output names.
 */
import {
  buildWorkflowRunResult,
  createPlanNodeStore,
  createResidentScheduleStore,
  linkEndedRun,
  requestResidentWake,
  RUN_WAKE_SESSION_METADATA_KEY,
  type ResidentWakeOutcome,
  type WorkflowRunDetail,
} from '@aflow/cybernetic-runtime';
import { PlanNodeLinkCreateSchema, RUN_PULL_REQUEST_URL_OUTPUT } from '@aflow/schemas';
import type { HarnessDeps } from './types.js';

/** The pull request the run holds, when its promoted output names one a link can carry. */
async function pullRequestOf(
  deps: HarnessDeps,
  tenantId: string,
  run: WorkflowRunDetail & { planNodeId: string },
): Promise<string | undefined> {
  const result = await buildWorkflowRunResult(
    { db: deps.db, payloadStore: deps.payloadStore },
    { tenantId, run, scope: 'partial' },
  );
  const ref = result?.output?.[RUN_PULL_REQUEST_URL_OUTPUT];
  const link = PlanNodeLinkCreateSchema.safeParse({
    nodeId: run.planNodeId,
    kind: 'pull_request',
    ref,
  });
  return link.success ? link.data.ref : undefined;
}

export async function linkEndedRunToPlanNode(
  deps: HarnessDeps,
  tenantId: string,
  run: WorkflowRunDetail,
  status: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  if (run.planNodeId === undefined) return;
  const served = { ...run, planNodeId: run.planNodeId };
  const pullRequestUrl = await pullRequestOf(deps, tenantId, served);
  await linkEndedRun(
    {
      store: createPlanNodeStore(deps.db, tenantId),
      spaceId: run.spaceId,
      redis: deps.redis,
      tenantId,
    },
    {
      nodeId: run.planNodeId,
      runId: run.runId,
      slug: run.workflowSlug,
      status,
      ...(pullRequestUrl !== undefined ? { pullRequestUrl } : {}),
    },
  );
}

/**
 * A run a wake started for a node ended: wake the space's resident to act on
 * it, or mark the space pending for the wake in flight (Plan 331 D4). A run
 * a conversation started is that conversation's to answer, and wakes nothing.
 */
export async function wakeResidentOnRunEnd(
  deps: HarnessDeps,
  tenantId: string,
  run: WorkflowRunDetail,
): Promise<ResidentWakeOutcome | 'not_a_wake_run'> {
  const metadata = (run.metadata ?? {}) as Record<string, unknown>;
  if (run.planNodeId === undefined || typeof metadata[RUN_WAKE_SESSION_METADATA_KEY] !== 'string') {
    return 'not_a_wake_run';
  }
  return requestResidentWake(
    { redis: deps.redis, schedules: createResidentScheduleStore(deps.db) },
    { tenantId, spaceId: run.spaceId, cause: 'run_ended' },
  );
}
