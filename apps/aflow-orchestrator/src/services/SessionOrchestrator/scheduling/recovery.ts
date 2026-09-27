import {
  type TenantId,
  type SessionId,
  type StepExecutionId,
  type StepId,
  type OperationId,
  type IdempotencyKey,
  type TraceId,
  type StepType,
  type StepResultMessage,
} from '@aflow/schemas';
import {
  peekDueStepStallCandidates,
  refreshStepStallCandidate,
  dropStepStallCandidate,
  stepStallNextCheckAtMs,
  getSessionState,
  getStepState,
  getStepInFlight,
  hasAvailableExecutor,
  updateSessionState,
} from '@aflow/redis';
import { backgroundTaskControlPlane } from '@aflow/schemas';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import type { SessionOrchestratorBindings } from '../lifecycle/context.js';
import { isRescuableOrphan } from './rescuableOrphan.js';

// Resolved per run rather than at module load, so the process's installed
// control plane — operator overrides included — is the one consulted.
const orphanRecoveryRuntime = () =>
  backgroundTaskControlPlane().resolve('orchestrator.orphan_recovery');

export function createRecoverOrphanedSessions(bindings: SessionOrchestratorBindings) {
  const { deps, applyResult, forceCompleteInFlightStep } = bindings;
  const { redis, shardManager } = deps;

  return async function recoverOrphanedSessions(): Promise<{ paused: number; failed: number }> {
    const log = getOrchestratorLogger().child({ component: 'orphan-recovery' });
    const now = Date.now();
    let paused = 0;
    let failed = 0;

    try {
      // Shard recovery has already rewritten hot state for every run this
      // instance owns, so a step that survived the restart in flight is armed
      // by that write and appears here the moment its lower bound passes.
      const runtime = orphanRecoveryRuntime();
      if (runtime.mode !== 'enabled') return { paused, failed };
      const candidates = await peekDueStepStallCandidates(redis, runtime.maxBatch, now);
      log.debug(`Scanning ${String(candidates.length)} due step candidates for orphans`);

      for (const { tenantId, sessionId: runId, dueAtMs } of candidates) {
        if (shardManager && !shardManager.ownsRun(runId)) continue;

        const state = await getSessionState(redis, tenantId, runId);
        if (state?.status !== 'RUNNING' || !state.currentStepExecutionId) {
          await dropStepStallCandidate(redis, tenantId, runId, dueAtMs);
          continue;
        }

        const stepState = await getStepState(redis, tenantId, state.currentStepExecutionId);
        if (!stepState) {
          await dropStepStallCandidate(redis, tenantId, runId, dueAtMs);
          continue;
        }
        if (stepState.status !== 'SCHEDULED' && stepState.status !== 'STARTED') {
          await dropStepStallCandidate(redis, tenantId, runId, dueAtMs);
          continue;
        }

        const rescuable = await isRescuableOrphan(
          { redis, getStepState, getStepInFlight, hasAvailableExecutor, shardManager },
          state,
          { stepState, now },
        );
        if (!rescuable) {
          await refreshStepStallCandidate(
            redis,
            tenantId,
            runId,
            stepStallNextCheckAtMs(stepState, now),
          );
          continue;
        }

        const isAgentStep = stepState.stepType === 'agent';
        const ageMs = stepState.startedAt ? now - stepState.startedAt : now - stepState.scheduledAt;

        if (isAgentStep) {
          const forceCompleted = await forceCompleteInFlightStep(tenantId, runId, 'interrupted');
          if (forceCompleted) {
            paused++;
            log.info(
              `Recovered orphaned agent session ${runId}: paused (step was ${stepState.status} for ${String(ageMs)}ms with dead executor)`,
            );
          }
        } else {
          const syntheticResult: StepResultMessage = {
            messageVersion: 1,
            tenantId: tenantId as TenantId,
            sessionId: runId as SessionId,
            stepExecutionId: stepState.stepExecutionId as StepExecutionId,
            parentStepExecutionId:
              stepState.parentStepExecutionId != null
                ? (stepState.parentStepExecutionId as StepExecutionId)
                : null,
            stepId: stepState.stepId as StepId,
            stepType: stepState.stepType as StepType,
            operationId: stepState.operationId as OperationId,
            attempt: stepState.attempt,
            idempotencyKey: stepState.idempotencyKey as IdempotencyKey,
            status: 'FAILED',
            outputRef: null,
            errorRef: null,
            requestedInputRef: null,
            error: {
              code: 'STEP_ABANDONED',
              // Required by the schema. Without it the whole object fails to parse
              // as an AflowError, and the failure is reported as a non-retryable
              // internal one — the opposite of what an abandoned step is.
              classification: 'transient' as const,
              message:
                `Step was in-flight when the system restarted. ` +
                `The executor's result is irrecoverably lost (${stepState.stepType}, ${String(ageMs)}ms).`,
              retryable: true,
              timestamp: new Date(now).toISOString(),
            },
            traceId: (state.traceId ?? crypto.randomUUID()) as TraceId,
            finishedAtMs: now,
          };
          try {
            await applyResult({
              result: syntheticResult,
              messageId: `orphan-recovery:${stepState.stepExecutionId}`,
            });
            failed++;
            log.info(
              `Recovered orphaned step ${stepState.stepId} (${stepState.stepType}) in run ${runId}: synthetic failure`,
            );
          } catch (applyErr) {
            logOrchestratorError(
              `[orphan-recovery] Failed to apply synthetic failure for step ${stepState.stepExecutionId}`,
              applyErr,
              { tenantId, runId },
            );
          }
        }

        if (state.interruptRequested) {
          await updateSessionState(redis, tenantId, runId, {
            interruptRequested: false,
          });
        }
      }
    } catch (err) {
      logOrchestratorError('[orphan-recovery] Orphan recovery scan failed', err, {
        component: 'orphan-recovery',
      });
    }

    if (paused > 0 || failed > 0) {
      log.info(`Orphan recovery complete: ${String(paused)} paused, ${String(failed)} failed`);
    }

    return { paused, failed };
  };
}
