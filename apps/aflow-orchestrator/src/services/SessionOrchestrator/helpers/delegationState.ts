/**
 * Delegation lifecycle helpers — canonical enter/leave transitions for
 * parent sessions waiting on child sub-agents.
 *
 * These helpers are the ONLY way to transition delegation state. All code
 * paths that enter or leave child-wait MUST use these functions to prevent
 * stale delegation fields from leaking across delegation cycles.
 *
 * Background: delegation metadata (`delegationPauseSource`, `delegationWaitMode`,
 * `pauseType`, `pausedChildSessionId`, `childPausedStepExecutionId`) is stored
 * as optional Redis hash fields. If any exit path forgets to clear a field,
 * the stale value persists and can block legitimate operations later (e.g.,
 * `bubbleChildPauseToParent` skipping because it sees stale `child_running`).
 */
import type { Redis } from 'ioredis';
import { updateSessionState } from '@aflow/redis';
import { buildRunStatusChangedRecoveryEvent } from './recoveryEmitter.js';

/**
 * All delegation-related fields that must be managed as a unit.
 * Every "leave" transition clears ALL of these to prevent stale state.
 */
const DELEGATION_FIELDS_TO_CLEAR = {
  delegationPauseSource: undefined,
  delegationWaitMode: undefined,
  pauseType: undefined,
  pausedChildSessionId: undefined,
  childPausedStepExecutionId: undefined,
  pauseReason: undefined,
  requestedInputRef: undefined,
} as const;

const LEAVE_CHILD_WAIT_CLEARED_FIELDS = [
  'delegationPauseSource',
  'delegationWaitMode',
  'pauseType',
  'pausedChildSessionId',
  'childPausedStepExecutionId',
  'pauseReason',
  'requestedInputRef',
] as const;

/**
 * Clear all delegation metadata, including the tracked waiting child list.
 *
 * Use on terminal parent transitions or anomaly recovery where the session
 * must categorically stop representing itself as blocked on children.
 */
export function getClearedDelegationStatePatch() {
  return {
    waitingForChildSessionIds: [] as string[],
    ...DELEGATION_FIELDS_TO_CLEAR,
  };
}

// ============================================================================
// Enter child-wait
// ============================================================================

export async function enterChildWait(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  opts: {
    waitMode: 'true' | 'until_pause' | 'false';
  },
): Promise<void> {
  await updateSessionState(redis, tenantId, sessionId, {
    status: 'WAITING_ON_CHILD',
    delegationPauseSource: 'child_running',
    pauseType: 'subflow_waiting',
    delegationWaitMode: opts.waitMode,
  });
}

// ============================================================================
// Leave child-wait → RUNNING (child completed or returned control)
// ============================================================================

// Ending a wait on the parent's own delegated work continues the activation
// that delegated it, so `activatedByPerson` is left as the wait found it.

export async function leaveChildWaitToRunning(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  opts?: { fromStatus?: string },
): Promise<void> {
  const recoveryEvents = opts?.fromStatus
    ? await buildRunStatusChangedRecoveryEvent(
        redis,
        tenantId,
        sessionId,
        opts.fromStatus,
        'RUNNING',
        {
          // `waitingForChildSessionIds: []` matches the live write
          // (`getClearedDelegationStatePatch()` returns the same), so replay
          // ends with an empty array rather than a missing field — keeping
          // recovery replay byte-equivalent to live hot state.
          runStatePatch: {
            status: 'RUNNING',
            waitingForChildSessionIds: [],
          },
          clearedRunStateFields: LEAVE_CHILD_WAIT_CLEARED_FIELDS,
        },
      )
    : undefined;

  await updateSessionState(
    redis,
    tenantId,
    sessionId,
    {
      status: 'RUNNING',
      ...getClearedDelegationStatePatch(),
    },
    recoveryEvents,
  );
}

// ============================================================================
// Leave child-wait → WAITING_ON_CHILD (child-input relay: user input relayed,
// parent goes back to waiting for the child to finish)
// ============================================================================

const LEAVE_CHILD_INPUT_CLEARED_FIELDS = [
  'requestedInputRef',
  'pauseReason',
  'pausedChildSessionId',
  'childPausedStepExecutionId',
] as const;

export async function leaveChildInputToWaiting(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  opts?: {
    fromStatus?: string;
    /** Present when a resume relays an answer to the child: whether a person gave it. */
    activatedByPerson?: boolean;
  },
): Promise<void> {
  const activation =
    opts?.activatedByPerson !== undefined ? { activatedByPerson: opts.activatedByPerson } : {};
  const recoveryEvents = opts?.fromStatus
    ? await buildRunStatusChangedRecoveryEvent(
        redis,
        tenantId,
        sessionId,
        opts.fromStatus,
        'WAITING_ON_CHILD',
        {
          runStatePatch: {
            status: 'WAITING_ON_CHILD',
            delegationPauseSource: 'child_running',
            pauseType: 'subflow_waiting',
            ...activation,
          },
          clearedRunStateFields: LEAVE_CHILD_INPUT_CLEARED_FIELDS,
        },
      )
    : undefined;

  await updateSessionState(
    redis,
    tenantId,
    sessionId,
    {
      status: 'WAITING_ON_CHILD',
      delegationPauseSource: 'child_running',
      pauseType: 'subflow_waiting',
      ...activation,
      // Clear child-input fields — the child is running again
      requestedInputRef: undefined,
      pauseReason: undefined,
      pausedChildSessionId: undefined,
      childPausedStepExecutionId: undefined,
    },
    recoveryEvents,
  );
}
