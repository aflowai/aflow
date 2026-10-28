import { type SessionId, type TraceId, type IdempotencyKey } from '@aflow/schemas';
import {
  isSessionCorrupt,
  getSessionStateSafe,
  addControlMessage,
  atomicCompleteStep,
  markRunInactive,
} from '@aflow/redis';
import { getClearedDelegationStatePatch } from '../helpers/delegationState.js';
import { generateEventId } from '../helpers/ids.js';
import { buildRunStatusChangedRecoveryEvent } from '../helpers/recoveryEmitter.js';
import {
  enqueuePendingAndReconcile,
  isDelegationUpsertFailure,
} from '../handlers/enqueueDelegationCompletion.js';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import type { SessionOrchestrator, SessionStatus } from '../types.js';
import type { SessionOrchestratorBindings } from './context.js';
import { ControlConflictError } from '../../../lib/controlConflict.js';

export function createCancelRun(bindings: SessionOrchestratorBindings) {
  const { deps, forceCompleteInFlightStep } = bindings;
  const { redis, manifestService } = deps;

  return async function cancelRun(
    params: Parameters<SessionOrchestrator['cancelRun']>[0],
  ): Promise<{ status: SessionStatus }> {
    const now = Date.now();

    if (await isSessionCorrupt(redis, params.tenantId, params.runId)) {
      throw new Error(`Run ${params.runId} is stalled (state corrupt); clear quarantine to retry`);
    }

    const runResult = await getSessionStateSafe(redis, params.tenantId, params.runId);
    if (!runResult.ok) {
      throw new ControlConflictError('run_not_found', `Run ${params.runId} not found in Redis`);
    }
    const runState = runResult.state;

    const forceCompleted = await forceCompleteInFlightStep(
      params.tenantId,
      params.runId,
      'cancelled',
    );

    if (!forceCompleted) {
      const cancelRecoveryEvents = await buildRunStatusChangedRecoveryEvent(
        redis,
        params.tenantId,
        params.runId,
        runState.status,
        'CANCELLED',
      );

      await atomicCompleteStep(
        redis,
        params.tenantId,
        { stepExecutionId: runState.currentStepExecutionId ?? params.runId },
        {
          sessionId: params.runId,
          status: 'CANCELLED',
          endedAt: now,
          ...getClearedDelegationStatePatch(),
        },
        {
          eventId: generateEventId(),
          eventType: 'SessionCancelled',
          timestamp: now,
          sessionId: params.runId,
        },
        undefined,
        cancelRecoveryEvents,
      );

      await markRunInactive(redis, params.tenantId, params.runId).catch(() => {});

      manifestService?.updateStatus(params.runId, params.tenantId, 'CANCELLED');
    }

    if (runState.waitingForChildSessionIds?.length) {
      for (const childId of runState.waitingForChildSessionIds) {
        try {
          await addControlMessage(redis, {
            messageVersion: 1,
            type: 'cancel_run',
            tenantId: params.tenantId,
            runId: childId as SessionId,
            traceId: (runState.traceId ?? crypto.randomUUID()) as TraceId,
            idempotencyKey: `cancel-cascade:${params.runId}:${childId}` as IdempotencyKey,
            requestedAtMs: Date.now(),
          });
        } catch (cancelErr) {
          logOrchestratorError(
            `[cancelRun] Failed to cascade cancel to child ${childId}:`,
            cancelErr,
            { tenantId: params.tenantId, runId: params.runId, childId },
          );
        }
      }
      getOrchestratorLogger().debug(
        `[cancelRun] Cascaded cancel to ${String(runState.waitingForChildSessionIds.length)} ` +
          `child run(s) of parent ${params.runId}`,
      );
    }

    if (runState.parentSessionId) {
      try {
        await enqueuePendingAndReconcile({
          redis,
          tenantId: params.tenantId,
          childRunId: params.runId,
          reason: 'cancelRun',
          ...(runState.parentStepExecutionId
            ? {
                parentRunId: runState.parentSessionId,
                parentStepExecutionId: runState.parentStepExecutionId,
              }
            : {}),
          childError: {
            code: 'SUBFLOW_CANCELLED',
            message: 'Sub-agent run was cancelled',
            classification: 'cancelled',
            retryable: false,
          },
        });
      } catch (resumeErr) {
        if (isDelegationUpsertFailure(resumeErr)) throw resumeErr;
        logOrchestratorError(
          `[cancelRun] Failed to resume parent after child ${params.runId} cancelled:`,
          resumeErr,
          { tenantId: params.tenantId, runId: params.runId },
        );
      }
    }

    return { status: 'CANCELLED' as SessionStatus };
  };
}
