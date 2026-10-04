import { getOperation, type StepId } from '@aflow/schemas';
import {
  getSessionStateSafe,
  getStepState,
  markRunActive,
  updateSessionState,
  appendSessionEvent,
  markSessionDirty,
  hasAvailableExecutor,
  setRunAccessGrant,
  type SessionEvent,
} from '@aflow/redis';
import { fetchAgentDef } from '../helpers/fetchAgentDef.js';
import {
  getEffectiveStateVariables,
  getVariableVersion,
  serializeOverlay,
} from '../helpers/runtimeState.js';
import { agentChatInputVarId, ensureAgentChatInputOverlay } from '../helpers/inputPause.js';
import { generateEventId } from '../helpers/ids.js';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';
import type { SessionOrchestrator, SessionStatus, ToolResultSummary } from '../types.js';
import type { SessionOrchestratorBindings } from './context.js';
import { ControlConflictError } from '../../../lib/controlConflict.js';

export function createRetryRun(bindings: SessionOrchestratorBindings) {
  const { deps, scheduleStep } = bindings;
  const { db, redis, payloadStore, manifestService } = deps;

  return async function retryRun(
    params: Parameters<SessionOrchestrator['retryRun']>[0],
  ): Promise<{ status: SessionStatus }> {
    const now = Date.now();

    const runResult = await getSessionStateSafe(redis, params.tenantId, params.runId);
    if (!runResult.ok) {
      throw new ControlConflictError('run_not_found', `Run ${params.runId} not found in Redis`);
    }
    const runState = runResult.state;

    if (runState.status !== 'FAILED') {
      console.warn(
        `[SessionOrchestrator] retryRun: run ${params.runId} is ${runState.status}, not FAILED — skipping (idempotent)`,
      );
      return { status: runState.status as SessionStatus };
    }

    const agentDef = await fetchAgentDef(
      db,
      payloadStore,
      params.tenantId,
      runState.target,
      runState.agentVersion,
    );

    let failedStepId: StepId | undefined;
    let failedStepState: Awaited<ReturnType<typeof getStepState>> | undefined;

    if (params.stepExecutionId) {
      failedStepState = await getStepState(redis, params.tenantId, params.stepExecutionId);
      if (failedStepState) {
        failedStepId = failedStepState.stepId as StepId;
      }
    }

    if (!failedStepId && runState.currentStepId) {
      failedStepId = runState.currentStepId as StepId;
      if (runState.currentStepExecutionId) {
        failedStepState = await getStepState(
          redis,
          params.tenantId,
          runState.currentStepExecutionId,
        );
      }
    }

    if (!failedStepId) {
      throw new Error(
        `Run ${params.runId}: cannot determine failed step for retry — no stepExecutionId provided and no currentStepId in run state`,
      );
    }

    const stepDef = agentDef.steps.find((s) => s.stepId === failedStepId);
    if (!stepDef) {
      throw new Error(`Run ${params.runId}: step ${failedStepId} not found in flow definition`);
    }

    const opDesc = getOperation(stepDef.operation);
    const resumeStrategy = opDesc?.defaultResumeStrategy ?? 'rerun_parent_agent_turn';

    let targetStepId: StepId = failedStepId;

    if (resumeStrategy === 'rerun_parent_agent_turn') {
      let parentAgentStepId: StepId | undefined;

      if (failedStepState?.parentStepExecutionId) {
        const parentStepState = await getStepState(
          redis,
          params.tenantId,
          failedStepState.parentStepExecutionId,
        );
        if (parentStepState?.operationId === 'ai.agent.turn') {
          parentAgentStepId = parentStepState.stepId as StepId;
        }
      }

      if (!parentAgentStepId) {
        for (const s of agentDef.steps) {
          if (s.operation === 'ai.agent.turn') {
            parentAgentStepId = s.stepId as StepId;
            break;
          }
        }
      }

      if (parentAgentStepId) {
        targetStepId = parentAgentStepId;
      } else {
        console.warn(
          `[SessionOrchestrator] retryRun: no parent agent turn found for step ${failedStepId}, falling back to rerun_failed_step`,
        );
      }
    }

    const targetStepDef = agentDef.steps.find((s) => s.stepId === targetStepId);
    if (targetStepDef) {
      const executorAvailable = await hasAvailableExecutor(redis, targetStepDef.stepType);
      if (!executorAvailable) {
        throw new Error(
          `Cannot retry: no executor available for step type "${targetStepDef.stepType}". ` +
            `Ensure the ${targetStepDef.stepType} executor is running and try again.`,
        );
      }
    }

    if (params.inputRef && targetStepDef?.operation === 'ai.agent.turn') {
      const runtimeState = runState.runtimeState ?? { version: 0, variables: {} };
      const chatVarId = agentChatInputVarId(targetStepId);
      const effectiveVars = getEffectiveStateVariables(agentDef, runState);
      if (!effectiveVars.some((v: { variableId: string }) => v.variableId === chatVarId)) {
        const overlay = ensureAgentChatInputOverlay(runState, targetStepId);
        await updateSessionState(redis, params.tenantId, params.runId, {
          variableDefsOverlay: serializeOverlay(overlay),
        });
      }

      try {
        const userInput = await payloadStore.retrieve(params.inputRef);
        const userMessage =
          typeof userInput === 'object' && userInput !== null && 'input' in userInput
            ? String((userInput as Record<string, unknown>)['input'])
            : typeof userInput === 'string'
              ? userInput
              : undefined;

        if (userMessage) {
          const newVariables = { ...runtimeState.variables };
          newVariables[chatVarId] = {
            ref: { kind: 'inline' as const, value: userMessage },
            updatedAtMs: now,
            updatedBy: {
              stepExecutionId: failedStepState?.stepExecutionId ?? params.runId,
              stepId: failedStepId,
              actor: 'api' as const,
            },
            version: getVariableVersion(newVariables[chatVarId]) + 1,
          };
          await updateSessionState(redis, params.tenantId, params.runId, {
            runtimeState: {
              schemaVersion: 1 as const,
              updatedAtMs: now,
              ...runtimeState,
              variables: newVariables,
              version: runtimeState.version + 1,
            },
          });

          getOrchestratorLogger().debug(
            `[retryRun] Wrote corrective input to ${chatVarId} for agent retry`,
          );
        }
      } catch (inputErr) {
        getOrchestratorLogger().warn(
          `[retryRun] Failed to map corrective input: ${inputErr instanceof Error ? inputErr.message : String(inputErr)}`,
        );
      }
    }

    const newRetryCount = (runState.retryCount ?? 0) + 1;
    await updateSessionState(redis, params.tenantId, params.runId, {
      status: 'RUNNING',
      endedAt: undefined,
      errorRef: undefined,
      retryCount: newRetryCount,
      lastUpdatedAt: now,
      interruptRequested: false,
      activatedByPerson: params.activatedByPerson,
    });

    // A retry re-enters RUNNING, so the run takes its capacity back. Failing
    // to re-add it left a live run invisible to admission control and to the
    // reclaim that keys off shards holding active runs.
    await markRunActive(redis, params.tenantId, params.runId).catch(() => {});

    const retriedEvent: SessionEvent = {
      eventId: generateEventId(),
      eventType: 'SessionRetried',
      timestamp: now,
      sessionId: params.runId,
      stepId: failedStepId,
      metadata: {
        retriedBy: 'user',
        retryCount: newRetryCount,
        failedStepId,
        resumeStrategy,
        hasCorrectiveInput: !!params.inputRef,
      },
    };
    await appendSessionEvent(redis, params.tenantId, params.runId, retriedEvent);
    await markSessionDirty(redis, params.tenantId, params.runId);

    if (params.actorContext) {
      try {
        const { compileRunAccessGrant } = await import('@aflow/authz');
        const grant = await compileRunAccessGrant(
          {
            tenantId: params.tenantId,
            spaceId: params.actorContext.spaceId ?? runState.spaceId ?? params.tenantId,
            spaceRole: params.actorContext.spaceRole ?? 'viewer',
            userId: params.actorContext.userId,
            tenantRole: params.actorContext.tenantRole,
            grantReason: 'resume',
          },
          db,
        );
        await setRunAccessGrant(redis, params.tenantId, params.runId, grant);
      } catch (grantErr) {
        console.warn(
          `[SessionOrchestrator] Grant re-stamp failed on retry for run ${params.runId}:`,
          grantErr instanceof Error ? grantErr.message : String(grantErr),
        );
      }
    }

    manifestService?.updateStatus(params.runId, params.tenantId, 'RUNNING');

    let retryToolResults: ToolResultSummary[] | undefined;
    if (targetStepDef?.operation === 'ai.agent.turn' && failedStepState?.errorRef) {
      let errorSummary = 'Previous attempt failed';
      try {
        const errorPayload = await payloadStore.retrieve(failedStepState.errorRef);
        if (errorPayload && typeof errorPayload === 'object') {
          const ep = errorPayload as { message?: string; code?: string };
          errorSummary = ep.message ?? ep.code ?? 'Previous attempt failed';
        }
      } catch {
        /* best-effort */
      }
      retryToolResults = [
        {
          toolCallId: `retry-error-${failedStepId}`,
          toolId: failedStepId,
          name: failedStepState.operationId,
          status: 'FAILED',
          summary: `Previous execution failed: ${errorSummary}. This is a retry — try a different approach.`,
          operationId: failedStepState.operationId,
          error: {
            error: 'validation',
            message: errorSummary.slice(0, 150),
            retry: false,
          },
        },
      ];
    }

    await scheduleStep({
      context: {
        tenantId: params.tenantId,
        runId: params.runId,
        agentDefinition: agentDef,
        traceId: params.traceId,
        ...(runState.spaceId ? { spaceId: runState.spaceId } : {}),
      },
      stepId: targetStepId,
      inputRef: params.inputRef ?? failedStepState?.inputRef ?? runState.inputRef ?? ('' as never),
      ...(retryToolResults ? { lastToolResults: retryToolResults } : {}),
    });

    getOrchestratorLogger().debug(
      `[SessionOrchestrator] retryRun: run ${params.runId} retried (attempt ${String(newRetryCount)}), scheduling step ${targetStepId} (strategy: ${resumeStrategy})`,
    );

    return { status: 'RUNNING' as SessionStatus };
  };
}
