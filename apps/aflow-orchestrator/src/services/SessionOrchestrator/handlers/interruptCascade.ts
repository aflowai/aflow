import type { Redis } from 'ioredis';
import { addControlMessage, updateSessionState } from '@aflow/redis';
import type { SessionHotState } from '@aflow/redis';
import type { TenantId, SessionId, TraceId, IdempotencyKey } from '@aflow/schemas';

export interface InterruptCascadeDeps {
  redis: Redis;
  /** Logger compatible with `getOrchestratorLogger()`. */
  logger: {
    info: (msg: string) => void;
    error: (msg: string, err: unknown, context?: Record<string, unknown>) => void;
  };
  /** Override for tests. Defaults to live `addControlMessage` from `@aflow/redis`. */
  addControlMessage?: typeof addControlMessage;
  /** Override for tests. Defaults to live `updateSessionState` from `@aflow/redis`. */
  updateSessionState?: typeof updateSessionState;
}

export interface InterruptCascadeParams {
  tenantId: TenantId;
  parentRunId: SessionId;
  parentState: Pick<
    SessionHotState,
    'traceId' | 'waitingForChildSessionIds' | 'delegationPauseSource' | 'pausedChildSessionId'
  >;
}

export interface InterruptCascadeResult {
  /** Child run IDs that received the cascade (flag + cancel_run). */
  cascadedTo: string[];
}

/**
 * Cascade interrupt to all child runs reachable from a parent.
 *
 * The flag write and cancel_run send are best-effort per child; failures
 * are logged but do not abort the cascade for sibling children. Returns
 * the list of children that the cascade was attempted for (regardless of
 * per-child success/failure) so callers can log a summary.
 */
export async function cascadeInterruptToChildren(
  deps: InterruptCascadeDeps,
  params: InterruptCascadeParams,
): Promise<InterruptCascadeResult> {
  const sendControl = deps.addControlMessage ?? addControlMessage;
  const writeState = deps.updateSessionState ?? updateSessionState;

  const { tenantId, parentRunId, parentState } = params;
  const seen = new Set<string>();
  const targets: string[] = [];

  for (const id of parentState.waitingForChildSessionIds ?? []) {
    if (!seen.has(id)) {
      seen.add(id);
      targets.push(id);
    }
  }

  if (
    parentState.delegationPauseSource === 'child_input' &&
    parentState.pausedChildSessionId &&
    !seen.has(parentState.pausedChildSessionId)
  ) {
    seen.add(parentState.pausedChildSessionId);
    targets.push(parentState.pausedChildSessionId);
  }

  for (const childId of targets) {
    // 1. Defense-in-depth: write the interrupt flag to the child's hot
    //    state. A child whose currentStep is PAUSED on user.input.request
    //    will see this flag at its next wake-up.
    try {
      await writeState(deps.redis, tenantId, childId as SessionId, {
        interruptRequested: true,
      });
    } catch (flagErr) {
      deps.logger.error(
        `[cascadeInterruptToChildren] Failed to set interruptRequested on child ${childId}:`,
        flagErr,
        { tenantId, runId: parentRunId, childId },
      );
    }

    // 2. Primary terminator: send cancel_run. Active children act on it
    //    immediately; PAUSED-step children will be handled by the flag
    //    plus the cancel_run consumer when it dispatches.
    try {
      await sendControl(deps.redis, {
        messageVersion: 1,
        type: 'cancel_run',
        tenantId,
        runId: childId as SessionId,
        traceId: (parentState.traceId ?? crypto.randomUUID()) as TraceId,
        idempotencyKey: `interrupt-cascade:${parentRunId}:${childId}` as IdempotencyKey,
        requestedAtMs: Date.now(),
      });
    } catch (cancelErr) {
      deps.logger.error(
        `[cascadeInterruptToChildren] Failed to send cancel_run to child ${childId}:`,
        cancelErr,
        { tenantId, runId: parentRunId, childId },
      );
    }
  }

  if (targets.length > 0) {
    deps.logger.info(
      `[cascadeInterruptToChildren] Cascaded interrupt to ${String(targets.length)} ` +
        `child run(s) of parent ${parentRunId}`,
    );
  }

  return { cascadedTo: targets };
}
