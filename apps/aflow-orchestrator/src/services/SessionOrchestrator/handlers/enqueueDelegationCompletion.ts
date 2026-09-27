import type { Redis } from 'ioredis';
import { upsertPendingDelegationCompletion, getSessionState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { AgentDefinition, SessionId, SessionAgentTarget } from '@aflow/schemas';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import {
  reconcileParentDelegationForChild,
  type ReconcileOutcome,
} from './reconcileParentDelegation.js';
import type { ChildErrorInfo } from './resumeParentOnChildComplete.js';

/**
 * Marker error: thrown when the durable pending-lifecycle upsert fails.
 * Callers MUST re-throw this error so the surrounding result-stream
 * processing fails and the message is redelivered (not acked). Catch-
 * and-log would silently break the at-least-once invariant.
 */
export class DelegationLifecycleUpsertFailed extends Error {
  override readonly name = 'DelegationLifecycleUpsertFailed';
  constructor(
    public readonly tenantId: string,
    public readonly childRunId: string,
    public readonly parentRunId: string,
    public readonly parentStepExecutionId: string,
    cause: unknown,
  ) {
    super(
      `upsertPendingDelegationCompletion failed for child=${childRunId} parent=${parentRunId} step=${parentStepExecutionId}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    if (cause instanceof Error && 'cause' in Error.prototype) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Returns true if the given error came from a failed upsert. Use this
 * in outer try/catch blocks to re-throw the upsert failure while still
 * swallowing reconcile errors:
 *
 *   try {
 *     await enqueuePendingAndReconcile({...});
 *   } catch (err) {
 *     if (isDelegationUpsertFailure(err)) throw err;
 *     logOrchestratorError('reconcile failed', err);  // best-effort
 *   }
 */
export function isDelegationUpsertFailure(err: unknown): err is DelegationLifecycleUpsertFailed {
  return err instanceof DelegationLifecycleUpsertFailed;
}

type AgentDefLoader = (
  tenantId: string,
  target: SessionAgentTarget,
  agentVersion: string,
) => Promise<AgentDefinition>;

export interface EnqueueAndReconcileParams {
  redis: Redis;
  payloadStore?: PayloadStore;
  tenantId: string;
  /** The child session ID — the one that just reached a resting state. */
  childRunId: string;
  /** Reason string forwarded to reconcile for logging. */
  reason: string;
  agentDefLoader?: AgentDefLoader;
  childError?: ChildErrorInfo;
  /**
   * Optional explicit parent linkage. When omitted, the helper reads it
   * from the child's hot state. Passing explicit values is preferable
   * when the caller already has the runState in scope (saves a Redis
   * round trip + survives child-state corruption races).
   */
  parentRunId?: string;
  parentStepExecutionId?: string;
}

/**
 * Upsert the pending lifecycle entry for the child, then run the
 * event-driven reconcile. Both halves of the at-least-once invariant
 * happen here.
 *
 * If parent linkage cannot be resolved (no parentSessionId/
 * parentStepExecutionId on the child), the upsert is skipped. This
 * matches `reconcileParentDelegationForChild`'s own short-circuit and
 * is a no-op for non-delegated sessions.
 */
export async function enqueuePendingAndReconcile(
  params: EnqueueAndReconcileParams,
): Promise<ReconcileOutcome | 'no_parent_linkage'> {
  const { redis, payloadStore, tenantId, childRunId, reason, agentDefLoader, childError } = params;

  let parentRunId = params.parentRunId;
  let parentStepExecutionId = params.parentStepExecutionId;

  if (!parentRunId || !parentStepExecutionId) {
    const childState = await getSessionState(redis, tenantId, childRunId);
    if (!childState?.parentSessionId || !childState.parentStepExecutionId) {
      // Not a delegated session — nothing to enqueue, nothing to reconcile.
      return 'no_parent_linkage';
    }
    parentRunId = childState.parentSessionId as SessionId;
    parentStepExecutionId = childState.parentStepExecutionId;
  }

  // Step 1: durable upsert. Must happen BEFORE the caller acks the
  // result-stream message so a crash here is replay-safe. Upsert
  // failures throw a marker error so callers can fail-closed (i.e.
  // not ack the result-stream message).
  try {
    await upsertPendingDelegationCompletion(
      redis,
      tenantId,
      childRunId,
      parentRunId,
      parentStepExecutionId,
    );
  } catch (err) {
    logOrchestratorError(
      `[delegation-lifecycle] upsertPendingDelegationCompletion failed — failing closed so the ` +
        `result-stream message is redelivered`,
      err,
      {
        tenantId,
        childRunId,
        parentRunId,
        parentStepExecutionId,
      },
    );
    throw new DelegationLifecycleUpsertFailed(
      tenantId,
      childRunId,
      parentRunId,
      parentStepExecutionId,
      err,
    );
  }

  // Step 2: eager reconcile — fires the synthetic parent result on the
  // happy path. The drain re-fires this if reconcile or its downstream
  // application drops the result. Reconcile errors are NOT load-bearing
  // here; the pending entry is durable and the drain will retry. We
  // still let them propagate so callers can log them, but callers
  // should NOT re-throw on non-upsert errors (use isDelegationUpsertFailure).
  return reconcileParentDelegationForChild({
    redis,
    tenantId,
    childRunId,
    reason,
    ...(payloadStore ? { payloadStore } : {}),
    ...(agentDefLoader ? { agentDefLoader } : {}),
    ...(childError ? { childError } : {}),
  });
}
