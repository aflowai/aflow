import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import { getSessionState, markRunInactive, type SessionHotState } from '@aflow/redis';
import { routeRunnerTerminalToHarness } from '../../cybernetic/WorkflowRunHarness.js';
import {
  enqueuePendingAndReconcile,
  isDelegationUpsertFailure,
} from './enqueueDelegationCompletion.js';
import { failRun } from './failRun.js';
import { fetchAgentDef } from '../helpers/fetchAgentDef.js';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';

export interface PauseRoutingDeps {
  redis: Redis;
  payloadStore: PayloadStore;
  db?: PostgresJsDatabase | undefined;
  guardrailGate?: { cleanupRun(tenantId: string, runId: string): void } | undefined;
  manifestService?:
    { updateStatus(runId: string, tenantId: string, status: string): void } | undefined;
}

export interface PauseRoutingArgs {
  tenantId: string;
  runId: string;
  traceId?: string | undefined;
  /** Session hot state when the caller holds it; fetched fresh otherwise.
   *  Only the immutable linkage fields are read, so a pre-pause snapshot is fine. */
  runState?: SessionHotState | undefined;
  /** The pause's resume contract (requestedInputRef); null when the pause carries none. */
  contractRef: string | null;
  /** Operator-readable pause reason — becomes the failure reason at the floor. */
  pauseReason: string;
  /**
   * Whether a throw from this call reaches a consumer that will NOT ack its
   * message, so redelivery retries the routing (applyResult under
   * ResultConsumer). When false — control-message and timer contexts that ack
   * unconditionally — a durable-upsert failure goes to the floor instead of
   * being rethrown into a void.
   */
  replayCarriesRetry?: boolean;
}

export type PauseRoutingOutcome =
  'harness_notified' | 'parent_notified' | 'not_autonomous' | 'failed_floor';

/**
 * A paused session is only parked, never abandoned: whoever is waiting on it
 * must learn about the pause, because nothing else will tell them. Notification
 * is one-shot — there is no sweeper that later reconciles a paused child with a
 * waiting parent — so a pause that skips this routing strands the parent in
 * WAITING_ON_CHILD (or the workflow task in running) permanently.
 *
 * Every session-pause producer whose session can be autonomous (delegated
 * child or workflow-task runner) reaches this after the pause commits — either
 * directly or through applyResult's post-`handled` sweep. Human sessions route
 * to 'not_autonomous' and are untouched — the person watching the chat is the
 * subscriber. Duplicate routing is safe: the harness treats a repeated paused
 * result as already-delivered, and reconcile is idempotent per child state.
 *
 * When the subscriber cannot be reached, the run FAILS instead of staying
 * paused: a failed run resolves the parent's wait through the failure
 * machinery, is visible as a failed task, and is retryable (`retryRun`
 * requires FAILED) — a paused run nobody knows about is none of those.
 *
 * The one exception is a delegation-upsert failure with `replayCarriesRetry`:
 * it is rethrown rather than floored, so the caller's stream message is not
 * acked and redelivery retries the notification with the pause intact.
 */
export async function routeSessionPauseToSubscribers(
  deps: PauseRoutingDeps,
  args: PauseRoutingArgs,
): Promise<PauseRoutingOutcome> {
  const replayCarriesRetry = args.replayCarriesRetry ?? true;
  const runState =
    args.runState ?? (await getSessionState(deps.redis, args.tenantId, args.runId)) ?? undefined;
  if (!runState) return 'not_autonomous';

  if (runState.workflowExecution !== undefined) {
    if (!deps.db) {
      await failRunAtFloor(deps, args, runState, new Error('harness deps unavailable (no db)'));
      return 'failed_floor';
    }
    try {
      await routeRunnerTerminalToHarness(
        { db: deps.db, redis: deps.redis, payloadStore: deps.payloadStore },
        {
          tenantId: args.tenantId,
          ...(args.traceId ? { traceId: args.traceId } : {}),
          workflowExecution: runState.workflowExecution,
        },
        'PAUSED',
        { contractRef: args.contractRef },
      );
      return 'harness_notified';
    } catch (err) {
      await failRunAtFloor(deps, args, runState, err);
      return 'failed_floor';
    }
  }

  if (runState.parentSessionId) {
    try {
      await enqueuePendingAndReconcile({
        redis: deps.redis,
        payloadStore: deps.payloadStore,
        tenantId: args.tenantId,
        childRunId: args.runId,
        reason: 'pause_routing',
        ...(runState.parentStepExecutionId
          ? {
              parentRunId: runState.parentSessionId,
              parentStepExecutionId: runState.parentStepExecutionId,
            }
          : {}),
        ...(deps.db
          ? {
              agentDefLoader: (tenantId, target, agentVersion) =>
                fetchAgentDef(deps.db!, deps.payloadStore, tenantId, target, agentVersion),
            }
          : {}),
      });
      return 'parent_notified';
    } catch (err) {
      if (replayCarriesRetry && isDelegationUpsertFailure(err)) throw err;
      await failRunAtFloor(deps, args, runState, err);
      return 'failed_floor';
    }
  }

  return 'not_autonomous';
}

/**
 * The floor rides the standard failure machinery: `failRun` clears the pause
 * and delegation fields, emits SessionFailed with recovery events, fires
 * completion schedules, and reconciles a delegated parent with the child
 * error — everything a hand-rolled FAILED write would silently skip. On top of
 * it: the shard active-run count (a paused run still holds a slot), guardrail
 * accumulator cleanup, the manifest, and the harness FAILED notification for
 * workflow-task runners (failRun's reconcile only reaches session parents).
 */
async function failRunAtFloor(
  deps: PauseRoutingDeps,
  args: PauseRoutingArgs,
  runState: SessionHotState,
  routingError: unknown,
): Promise<void> {
  const routingMessage =
    routingError instanceof Error ? routingError.message : String(routingError);
  const message =
    `${args.pauseReason} — and the pause could not reach whoever is waiting on this session ` +
    `(${routingMessage}). Failed so the wait resolves instead of hanging forever.`;

  deps.guardrailGate?.cleanupRun(args.tenantId, args.runId);
  try {
    await failRun(deps.redis, args.tenantId, args.runId, 'PAUSE_UNROUTABLE', message, 'internal');
  } catch (failErr) {
    if ((args.replayCarriesRetry ?? true) && isDelegationUpsertFailure(failErr)) throw failErr;
    logOrchestratorError(
      `[pausedSessionRouting] failRun at the floor also failed for run ${args.runId} — ` +
        `the run may still read PAUSED and the waiting side needs manual attention:`,
      failErr,
      { tenantId: args.tenantId, runId: args.runId },
    );
    return;
  }
  await markRunInactive(deps.redis, args.tenantId, args.runId).catch(() => {});
  deps.manifestService?.updateStatus(args.runId, args.tenantId, 'FAILED');

  if (runState.workflowExecution !== undefined && deps.db) {
    try {
      await routeRunnerTerminalToHarness(
        { db: deps.db, redis: deps.redis, payloadStore: deps.payloadStore },
        {
          tenantId: args.tenantId,
          ...(args.traceId ? { traceId: args.traceId } : {}),
          workflowExecution: runState.workflowExecution,
        },
        'FAILED',
        { failureReason: message },
      );
    } catch (floorErr) {
      logOrchestratorError(
        `[pausedSessionRouting] FAILED notification also unreachable for run ${args.runId} — ` +
          `run is FAILED with reason recorded; the workflow task needs manual attention:`,
        floorErr,
        { tenantId: args.tenantId, runId: args.runId },
      );
    }
  }
}
