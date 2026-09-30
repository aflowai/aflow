import { createTenantContext, withTenantSchema } from '@aflow/database';
import {
  addAttentionItem,
  buildResumeContract,
  pauseRun,
  storeWorkflowResumeContract,
} from '@aflow/cybernetic-runtime';
import type { TenantId, WorkflowResumeContract } from '@aflow/schemas';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import type { InlineHandlerArgs } from '../handlers/inlineOps/types.js';
import { emitStepError, parkInlineStepForWorkflowWait } from '../handlers/inlineOps/helpers.js';
import { wakeParkedStepWithFailure } from '../handlers/inlineOps/workflowCrud/run/wakeParked.js';

export interface PauseWorkflowRunAtStartupArgs {
  db: PostgresJsDatabase;
  payloadStore: PayloadStore;
  tenantId: TenantId;
  spaceId: string;
  runId: string;
  contract: WorkflowResumeContract;
}

/**
 * Persist the contract, flip the run to `paused`, and write attention.
 * Caller must `addWaiter` then `notifyWaiters` after parking the Helmsman step.
 */
export async function pauseWorkflowRunAtStartup(
  args: PauseWorkflowRunAtStartupArgs,
): Promise<string> {
  const tenantIdStr = args.tenantId as string;
  const contractRef = await storeWorkflowResumeContract({
    payloadStore: args.payloadStore,
    tenantId: tenantIdStr,
    runId: args.runId,
    taskId: args.runId,
    attempt: 1,
    contract: args.contract,
  });

  const tenantCtx = createTenantContext(args.tenantId);
  await withTenantSchema(args.db, tenantCtx, async (tx) => {
    await pauseRun(
      args.db,
      tenantIdStr,
      args.runId,
      { reason: args.contract.pauseCause, payloadRef: contractRef },
      tx,
    );
    await addAttentionItem(
      args.db,
      tenantIdStr,
      {
        spaceId: args.spaceId,
        kind: 'workflow_run_paused',
        relatedRunId: args.runId,
        relatedResource: `workflow_run:${args.runId}`,
        payload: {
          pauseCause: args.contract.pauseCause,
          contractRef,
        },
        priority: 0,
      },
      tx,
    );
  });

  return contractRef;
}

export interface HandoffStartupPreflightPauseArgs {
  args: InlineHandlerArgs;
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore: PayloadStore;
  tenantId: TenantId;
  tenantIdStr: string;
  spaceId: string;
  runId: string;
  slug: string;
  contract: WorkflowResumeContract;
  startTime: number;
}

/**
 * Park Helmsman, pause the run with the contract, register waiter, notify.
 * On failure after `recordRunStart`, fail the run and surface a typed step error.
 */
export async function handoffStartupPreflightPause(
  handoff: HandoffStartupPreflightPauseArgs,
): Promise<void> {
  let parked = false;
  try {
    const contractRef = await pauseWorkflowRunAtStartup({
      db: handoff.db,
      payloadStore: handoff.payloadStore,
      tenantId: handoff.tenantId,
      spaceId: handoff.spaceId,
      runId: handoff.runId,
      contract: handoff.contract,
    });
    await parkInlineStepForWorkflowWait(handoff.args, {
      kind: 'waiting_on_workflow_run' as const,
      runId: handoff.runId,
      slug: handoff.slug,
      status: 'paused' as const,
    });
    parked = true;

    const { addWaiter } = await import('@aflow/cybernetic-runtime');
    await addWaiter(handoff.db, handoff.tenantIdStr, {
      runId: handoff.runId,
      waiterSessionId: handoff.args.context.runId,
      waiterStepExecutionId: handoff.args.stepExecutionId,
    });

    const { notifyWaiters } = await import('../../cybernetic/harness/waiters.js');
    await notifyWaiters(
      { db: handoff.db, redis: handoff.redis, payloadStore: handoff.payloadStore },
      {
        tenantId: handoff.tenantId,
        runId: handoff.runId,
        outcome: 'paused',
        payloadRef: contractRef,
      },
    );
  } catch (err) {
    const errMsg = await failRunAfterStartupPauseError(handoff, err);
    if (parked) {
      await wakeParkedStepWithFailure(
        handoff.args,
        'WORKFLOW_STARTUP_PAUSE_FAILED',
        `Workflow run ${handoff.runId} could not complete startup preflight pause handoff: ${errMsg}`,
      );
    } else {
      await emitStepError(
        handoff.args,
        'WORKFLOW_STARTUP_PAUSE_FAILED',
        `Workflow "${handoff.slug}" started but could not pause for preflight (${errMsg}). ` +
          'The run was marked failed; fix bindings and start again.',
        handoff.startTime,
        'internal',
      );
    }
  }
}

/**
 * Pause the run with the contract for a caller that does not wait on it:
 * nothing parks, and the pause reaches the session that started the run as a
 * wakeup, like any later pause. A failure fails the run, which reaches it too.
 */
export async function pauseStartupPreflightForSessionWaiter(
  handoff: Omit<HandoffStartupPreflightPauseArgs, 'args' | 'startTime'>,
): Promise<void> {
  try {
    const contractRef = await pauseWorkflowRunAtStartup({
      db: handoff.db,
      payloadStore: handoff.payloadStore,
      tenantId: handoff.tenantId,
      spaceId: handoff.spaceId,
      runId: handoff.runId,
      contract: handoff.contract,
    });
    const { notifyWaiters } = await import('../../cybernetic/harness/waiters.js');
    await notifyWaiters(
      { db: handoff.db, redis: handoff.redis, payloadStore: handoff.payloadStore },
      {
        tenantId: handoff.tenantId,
        runId: handoff.runId,
        outcome: 'paused',
        payloadRef: contractRef,
      },
    );
  } catch (err) {
    await failRunAfterStartupPauseError(handoff, err);
  }
}

async function failRunAfterStartupPauseError(
  handoff: Omit<HandoffStartupPreflightPauseArgs, 'args' | 'startTime'>,
  err: unknown,
): Promise<string> {
  const errMsg = err instanceof Error ? err.message : String(err);
  getOrchestratorLogger().error(
    `[startupPreflightPause] failed for run=${handoff.runId}: ${errMsg}`,
    err instanceof Error ? err : undefined,
    { tenantId: handoff.tenantIdStr, runId: handoff.runId, slug: handoff.slug },
  );
  try {
    const { completeRun } = await import('../../cybernetic/WorkflowRunHarness.js');
    await completeRun(
      { db: handoff.db, redis: handoff.redis, payloadStore: handoff.payloadStore },
      handoff.tenantId,
      handoff.runId,
      'failed',
    );
  } catch (completeErr) {
    getOrchestratorLogger().error(
      `[startupPreflightPause] completeRun(failed) recovery failed for run=${handoff.runId}`,
      completeErr instanceof Error ? completeErr : undefined,
      { tenantId: handoff.tenantIdStr, runId: handoff.runId },
    );
  }
  return errMsg;
}

export function buildNeedsCredentialsStartupContract(
  runId: string,
  missingBindings: Array<{ bindingId: string; bindingName: string; missingFields: string[] }>,
): WorkflowResumeContract {
  return buildResumeContract({
    pauseCause: 'needs_credentials',
    runId,
    blockedBindings: missingBindings,
  });
}

export function buildNeedsCapabilityStartupContract(
  runId: string,
  missingCapabilities: string[],
): WorkflowResumeContract {
  return buildResumeContract({
    pauseCause: 'needs_capability',
    runId,
    disabledCapabilities: missingCapabilities,
  });
}
