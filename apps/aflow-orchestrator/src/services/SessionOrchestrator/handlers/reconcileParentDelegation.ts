import type { Redis } from 'ioredis';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import type { AgentDefinition, SessionId, SessionAgentTarget } from '@aflow/schemas';
import { getSessionState, markSessionDirty, updateSessionState } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import { cyberneticHookSafe } from '@aflow/cybernetic-runtime';

import {
  getClearedDelegationStatePatch,
  leaveChildInputToWaiting,
} from '../helpers/delegationState.js';
import { resumeParentOnChildComplete, type ChildErrorInfo } from './resumeParentOnChildComplete.js';
import { bubbleChildPauseToParent } from './bubbleChildPause.js';

type AgentDefLoader = (
  tenantId: string,
  target: SessionAgentTarget,
  agentVersion: string,
) => Promise<AgentDefinition>;

export interface ReconcileParentDelegationParams {
  redis: Redis;
  tenantId: string;
  childRunId: string;
  reason: string;
  payloadStore?: PayloadStore;
  agentDefLoader?: AgentDefLoader;
  childError?: ChildErrorInfo;
}

function isTerminalStatus(status: string | undefined): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

/**
 * Whether the child is still somewhere the delegation machinery has nothing to
 * dispatch from. Not a liveness test — a RUNNING child whose executor died keeps
 * this status forever — which is why supervision uses it only to decide that a
 * child is somebody else's watchdog's problem, never to conclude it is alive.
 */
export function isActiveChildStatus(status: string | undefined): boolean {
  return (
    status === 'QUEUED' ||
    status === 'RUNNING' ||
    status === 'WAITING_ON_CHILD' ||
    status === 'STALLED' ||
    status === 'CANCELLING'
  );
}

async function reportDelegationAnomaly(params: {
  redis: Redis;
  tenantId: string;
  parentRunId: string;
  spaceId?: string;
  message: string;
}): Promise<void> {
  const { redis, tenantId, parentRunId, spaceId, message } = params;
  const log = getOrchestratorLogger().child({ component: 'delegation-reconcile' });
  log.warn(`[delegation-reconcile] ${message}`);

  if (!spaceId) return;

  await cyberneticHookSafe('orphan-recovery', () => Promise.reject(new Error(message)), {
    redis,
    tenantId,
    spaceId,
    runId: parentRunId,
  });
}

export type ReconcileOutcome =
  /** Parent step already terminal; nothing to do. */
  | 'parent_already_advanced'
  /** Synthetic parent result was pushed; parent step should apply shortly. */
  | 'result_enqueued'
  /** Parent's waitingForChildSessionIds doesn't include the child — idempotent no-op (expected during retries). */
  | 'parent_not_tracking_child'
  /** Parent session/state gone — escalate. */
  | 'parent_state_missing'
  /** Child session/state gone (or has no parent linkage) — use reverse index to fail parent step. */
  | 'child_state_missing'
  /** Parent is PAUSED+interrupted; user asked to stop the chain. Reconcile is suppressed by design. */
  | 'parent_interrupted_suppressed'
  /** Parent is in PAUSED+child_input but child is now active again — restored to WAITING_ON_CHILD. */
  | 'parent_restored_to_waiting'
  /** Required payloadStore / agentDefLoader missing for a PAUSED child — bubble could not fire. */
  | 'bubble_dependencies_missing'
  /** Child reached an unexpected status (RUNNING/QUEUED/...); nothing to dispatch yet. */
  | 'child_not_resting';

/**
 * Reconcile a parent's delegation state against the CURRENT child session state.
 *
 * This is safe to call repeatedly. It is intended for:
 * - normal child terminal / pause transitions
 * - late / duplicate result redelivery after a crash
 * - fallback error paths that may have persisted child state but missed parent wakeup
 *
 * Returns a typed outcome for the lifecycle drain. The legacy
 * `Promise<void>` callers can ignore the return value safely.
 */
export async function reconcileParentDelegationForChild(
  params: ReconcileParentDelegationParams,
): Promise<ReconcileOutcome> {
  const { redis, tenantId, childRunId, reason, payloadStore, agentDefLoader, childError } = params;
  const log = getOrchestratorLogger().child({ component: 'delegation-reconcile' });

  const childState = await getSessionState(redis, tenantId, childRunId);
  if (!childState?.parentSessionId || !childState.parentStepExecutionId) {
    return 'child_state_missing';
  }

  const parentRunId = childState.parentSessionId as SessionId;
  const parentState = await getSessionState(redis, tenantId, parentRunId);
  if (!parentState) return 'parent_state_missing';

  if (parentState.status === 'PAUSED' && parentState.pauseReason === 'interrupted') {
    log.debug(
      `[delegation-reconcile] Parent ${parentRunId} is PAUSED+interrupted — ` +
        `dropping reconcile for child ${childRunId} (reason=${reason})`,
    );
    return 'parent_interrupted_suppressed';
  }

  const waitingIds = parentState.waitingForChildSessionIds ?? [];
  const parentTracksChild =
    waitingIds.includes(childRunId) || parentState.pausedChildSessionId === childRunId;

  if (isTerminalStatus(parentState.status)) {
    if (
      waitingIds.length > 0 ||
      parentState.delegationPauseSource !== undefined ||
      parentState.pausedChildSessionId !== undefined ||
      parentState.childPausedStepExecutionId !== undefined
    ) {
      await updateSessionState(redis, tenantId, parentRunId, {
        ...getClearedDelegationStatePatch(),
      });
      await markSessionDirty(redis, tenantId, parentRunId);
      await reportDelegationAnomaly({
        redis,
        tenantId,
        parentRunId,
        ...(parentState.spaceId ? { spaceId: parentState.spaceId } : {}),
        message:
          `Cleared impossible child-wait state on terminal parent ${parentRunId} ` +
          `(child=${childRunId}, parentStatus=${parentState.status}, reason=${reason})`,
      });
    }
    return 'parent_already_advanced';
  }

  if (!parentTracksChild) {
    return 'parent_not_tracking_child';
  }

  if (
    parentState.status === 'PAUSED' &&
    parentState.delegationPauseSource === 'child_input' &&
    parentState.pausedChildSessionId === childRunId &&
    isActiveChildStatus(childState.status)
  ) {
    await leaveChildInputToWaiting(redis, tenantId, parentRunId, {
      fromStatus: parentState.status,
    });
    await markSessionDirty(redis, tenantId, parentRunId);
    log.info(
      `[delegation-reconcile] Restored parent ${parentRunId} to WAITING_ON_CHILD ` +
        `(child=${childRunId}, childStatus=${childState.status}, reason=${reason})`,
    );
    return 'parent_restored_to_waiting';
  }

  if (childState.status === 'PAUSED') {
    if (!payloadStore || !agentDefLoader) {
      log.warn(
        `[delegation-reconcile] Missing payloadStore/agentDefLoader for paused child ${childRunId}; ` +
          `cannot bubble pause (reason=${reason})`,
      );
      return 'bubble_dependencies_missing';
    }
    await bubbleChildPauseToParent(redis, payloadStore, tenantId, childRunId, agentDefLoader);
    return 'result_enqueued';
  }

  if (childState.status === 'SUCCEEDED') {
    await resumeParentOnChildComplete(
      redis,
      tenantId,
      childRunId,
      'SUCCEEDED',
      childState.finalOutputRef,
      payloadStore,
    );
    return 'result_enqueued';
  }

  if (childState.status === 'FAILED') {
    await resumeParentOnChildComplete(
      redis,
      tenantId,
      childRunId,
      'FAILED',
      childState.errorRef,
      undefined,
      childError,
    );
    return 'result_enqueued';
  }

  if (childState.status === 'CANCELLED') {
    await resumeParentOnChildComplete(redis, tenantId, childRunId, 'FAILED', undefined, undefined, {
      code: 'SUBFLOW_CANCELLED',
      message: 'Sub-agent run was cancelled',
      classification: 'cancelled',
      retryable: false,
    });
    return 'result_enqueued';
  }

  // Child is still active (RUNNING / QUEUED / WAITING_ON_CHILD / etc.) —
  // nothing to dispatch from here; another reconcile will fire when the
  // child reaches a resting state.
  return 'child_not_resting';
}
