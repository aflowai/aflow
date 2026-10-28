import { StreamKeys, type StepType } from '@aflow/schemas';
import {
  getSessionStateSafe,
  getStepState,
  atomicCompleteStep,
  markRunInactive,
  type SessionEvent,
} from '@aflow/redis';
import { buildInterruptedSessionPatch } from '../helpers/interruptedSessionPatch.js';
import { getClearedDelegationStatePatch } from '../helpers/delegationState.js';
import { generateEventId } from '../helpers/ids.js';
import { buildRunStatusChangedRecoveryEvent } from '../helpers/recoveryEmitter.js';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import type { SessionOrchestratorFactoryDeps } from './context.js';
import { routeSessionPauseToSubscribers } from '../handlers/pausedSessionRouting.js';

/**
 * Immediately transitions an in-flight step to FAILED and the run to
 * PAUSED (interrupt) or CANCELLED (cancel). The executor's late result,
 * if it ever arrives, is safely discarded by the terminal-state guard in applyResult.
 */
export function createForceCompleteInFlightStep(deps: SessionOrchestratorFactoryDeps) {
  const { redis, db, payloadStore, manifestService, guardrailGate } = deps;

  return async function forceCompleteInFlightStep(
    tenantId: string,
    runId: string,
    reason: 'interrupted' | 'cancelled',
  ): Promise<boolean> {
    const runResult = await getSessionStateSafe(redis, tenantId, runId);
    if (!runResult.ok) return false;
    const runState = runResult.state;

    const stepExecId = runState.currentStepExecutionId;
    if (!stepExecId) return false;

    const stepState = await getStepState(redis, tenantId, stepExecId);
    if (!stepState) return false;

    const isInterrupt = reason === 'interrupted';
    const isPausedDelegate =
      stepState.status === 'PAUSED' && stepState.operationId === 'agent.control.delegate';
    if (
      stepState.status !== 'STARTED' &&
      stepState.status !== 'SCHEDULED' &&
      !(isInterrupt && isPausedDelegate)
    ) {
      return false;
    }

    const now = Date.now();
    const errorCode = isInterrupt ? 'STEP_INTERRUPTED' : 'STEP_CANCELLED';
    const errorMessage = isInterrupt
      ? 'Step interrupted by user request'
      : 'Step cancelled by user request';

    // Resolve the chatInput stepId for the resumeContract. Three cases:
    //   1. The failed step IS the agent.turn — use its own stepId.
    //   2. The failed step is a CHILD of an ai.agent.turn (PAUSED delegate, or
    //      STARTED native-FC tool step) — climb to the parent agent.turn and
    //      use ITS stepId. Without this, an interrupt mid tool-call drops the
    //      user's resume message: forceCompleteInFlightStep would leave
    //      `chatInputStepId = null`, no resumeContract is built, and
    //      resumeRun's legacy fallback can't map `{ input: <text> }` onto any
    //      state variable so the message never reaches the next agent.turn's
    //      `ai.agent.chatInput.<stepId>`.
    //   3. No agent ancestor (e.g. a standalone compute step in a non-agent
    //      flow) — chatInputStepId stays null and the patch carries no
    //      resumeContract / currentStepId override.
    const failedStepIsAgentTurn = stepState.operationId === 'ai.agent.turn';
    let chatInputStepId: string | null = null;
    if (failedStepIsAgentTurn) {
      chatInputStepId = stepState.stepId;
    } else if (stepState.parentStepExecutionId) {
      const agentStep = await getStepState(redis, tenantId, stepState.parentStepExecutionId);
      if (agentStep?.operationId === 'ai.agent.turn') {
        chatInputStepId = agentStep.stepId;
      }
    }
    const failedStepIsAgentChild = !failedStepIsAgentTurn && chatInputStepId !== null;

    const stepFailedEvent: SessionEvent = {
      eventId: generateEventId(),
      eventType: 'StepFailed',
      timestamp: now,
      sessionId: runId,
      stepId: stepState.stepId,
      stepExecutionId: stepExecId,
      stepType: stepState.stepType as StepType,
      attempt: stepState.attempt,
      metadata: {
        errorCode,
        errorMessage,
        classification: 'cancelled',
        reason,
      },
    };

    const runEvent: SessionEvent = isInterrupt
      ? {
          eventId: generateEventId(),
          eventType: 'SessionPaused',
          timestamp: now,
          sessionId: runId,
          stepExecutionId: stepExecId,
          metadata: { pauseType: 'interrupted', reason: 'user_interrupt' },
        }
      : {
          eventId: generateEventId(),
          eventType: 'SessionCancelled',
          timestamp: now,
          sessionId: runId,
        };

    const events: SessionEvent[] = [stepFailedEvent, runEvent];

    const recoveryEvents = await buildRunStatusChangedRecoveryEvent(
      redis,
      tenantId,
      runId,
      runState.status,
      isInterrupt ? 'PAUSED' : 'CANCELLED',
    );

    const interruptPatch = isInterrupt
      ? buildInterruptedSessionPatch({
          stepExecId,
          isPausedDelegate,
          failedStepIsAgentChild,
          chatInputStepId,
        })
      : undefined;

    await atomicCompleteStep(
      redis,
      tenantId,
      {
        stepExecutionId: stepExecId,
        status: 'FAILED',
        endedAt: now,
      },
      {
        sessionId: runId,
        ...(interruptPatch
          ? { status: 'PAUSED' as const, ...interruptPatch }
          : {
              status: 'CANCELLED' as const,
              endedAt: now,
              ...getClearedDelegationStatePatch(),
            }),
      },
      events,
      undefined,
      recoveryEvents,
    );

    if (!isInterrupt) {
      await markRunInactive(redis, tenantId, runId).catch(() => {});
    }

    manifestService?.updateStatus(runId, tenantId, isInterrupt ? 'PAUSED' : 'CANCELLED');

    redis.publish(StreamKeys.stepAbortChannel(stepExecId), reason).catch(() => {});

    if (isInterrupt) {
      // The watchdog and orphan recovery force-pause any RUNNING session,
      // including delegated children and workflow-task runners — without this,
      // the force-pause is the one pause producer whose subscriber never hears.
      await routeSessionPauseToSubscribers(
        {
          redis,
          payloadStore,
          db,
          ...(guardrailGate ? { guardrailGate } : {}),
          ...(manifestService ? { manifestService } : {}),
        },
        {
          tenantId,
          runId,
          traceId: runState.traceId,
          contractRef: interruptPatch?.requestedInputRef ?? null,
          pauseReason: 'Session was interrupted',
          // Callers (interrupt API, stall watchdog, orphan recovery) ack or
          // proceed regardless of a throw from here.
          replayCarriesRetry: false,
        },
      );
    }

    getOrchestratorLogger().info(
      `[forceCompleteInFlightStep] Force-completed step ${stepExecId} (${reason}) for run ${runId}`,
    );

    return true;
  };
}
