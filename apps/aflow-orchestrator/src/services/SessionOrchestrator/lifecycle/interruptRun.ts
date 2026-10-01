import type { StepType } from '@aflow/schemas';
import {
  isSessionCorrupt,
  getSessionStateSafe,
  getStepState,
  updateSessionState,
  hasAvailableExecutor,
} from '@aflow/redis';
import { loadParkedStepWaitersForSession } from '@aflow/cybernetic-runtime';
import { cancelRun as cancelWorkflowRun } from '../../cybernetic/WorkflowRunHarness.js';
import { cascadeInterruptToChildren } from '../handlers/interruptCascade.js';
import { getOrchestratorLogger, logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import type { SessionOrchestrator, SessionStatus } from '../types.js';
import type { SessionOrchestratorBindings } from './context.js';
import { isDelegationWaitState } from './isDelegationWaitState.js';
import { ControlConflictError } from '../../../lib/controlConflict.js';

export function createInterruptRun(bindings: SessionOrchestratorBindings) {
  const { deps, harnessDeps, forceCompleteInFlightStep } = bindings;
  const { db, redis } = deps;

  return async function interruptRun(
    params: Parameters<SessionOrchestrator['interruptRun']>[0],
  ): Promise<{ status: SessionStatus }> {
    if (await isSessionCorrupt(redis, params.tenantId, params.runId)) {
      throw new Error(`Run ${params.runId} is stalled (state corrupt); clear quarantine to retry`);
    }

    const runResult = await getSessionStateSafe(redis, params.tenantId, params.runId);
    if (!runResult.ok) {
      throw new ControlConflictError('run_not_found', `Run ${params.runId} not found in Redis`);
    }
    const runState = runResult.state;

    const isDelegationWait = isDelegationWaitState(runState);

    const workflowWaiters = await loadParkedStepWaitersForSession(
      db,
      params.tenantId as string,
      params.runId,
    );
    const isWorkflowDelegationWait = workflowWaiters.length > 0;

    if (
      runState.status !== 'RUNNING' &&
      runState.status !== 'QUEUED' &&
      !isDelegationWait &&
      !isWorkflowDelegationWait
    ) {
      throw new ControlConflictError(
        'run_not_interruptible',
        `Run ${params.runId} cannot be interrupted: status is ${runState.status} ` +
          `(must be RUNNING, QUEUED, WAITING_ON_CHILD, PAUSED with child_input delegation, ` +
          `or PAUSED with a step parked on a workflow run)`,
        { observedStatus: runState.status },
      );
    }

    let resultStatus: SessionStatus;

    const forceCompleted = await forceCompleteInFlightStep(
      params.tenantId,
      params.runId,
      'interrupted',
    );

    if (forceCompleted) {
      getOrchestratorLogger().info(
        `[interruptRun] Run ${params.runId} force-paused (was ${runState.status})`,
      );
      resultStatus = 'PAUSED';
    } else {
      const stepExecId = runState.currentStepExecutionId;
      let retrySucceeded = false;
      if (stepExecId) {
        const stepState = await getStepState(redis, params.tenantId, stepExecId);
        if (stepState && (stepState.status === 'STARTED' || stepState.status === 'SCHEDULED')) {
          const executorAlive = await hasAvailableExecutor(redis, stepState.stepType as StepType);
          if (!executorAlive) {
            getOrchestratorLogger().warn(
              `[interruptRun] Executor dead for step ${stepExecId} (${stepState.stepType}); force-pausing run ${params.runId}`,
            );
            retrySucceeded = await forceCompleteInFlightStep(
              params.tenantId,
              params.runId,
              'interrupted',
            );
          }
        }
      }

      if (retrySucceeded) {
        resultStatus = 'PAUSED';
      } else {
        await updateSessionState(redis, params.tenantId, params.runId, {
          interruptRequested: true,
        });
        getOrchestratorLogger().info(
          `[interruptRun] No in-flight step to force-complete; interrupt flag set for run ${params.runId}`,
        );
        resultStatus = runState.status as SessionStatus;
      }
    }

    await cascadeInterruptToChildren(
      {
        redis,
        logger: {
          info: (msg) => {
            getOrchestratorLogger().info(msg);
          },
          error: (msg, err, ctx) => {
            logOrchestratorError(msg, err, ctx);
          },
        },
      },
      {
        tenantId: params.tenantId,
        parentRunId: params.runId,
        parentState: runState,
      },
    );

    if (workflowWaiters.length > 0) {
      getOrchestratorLogger().info(
        `[interruptRun] cascading workflow-run cancel to ${String(workflowWaiters.length)} ` +
          `waiter(s) for parent ${params.runId}`,
      );
      for (const waiter of workflowWaiters) {
        try {
          // The chat interrupt is the OPERATOR pulling the brake — the
          // cascaded run cancel carries operator intent (no auto-retry,
          // no post-run eval/Coach review on the aborted run).
          await cancelWorkflowRun(harnessDeps, params.tenantId, waiter.runId, {
            cancelledBy: 'operator',
            reason: 'helmsman_interrupted',
          });
        } catch (err) {
          logOrchestratorError(
            `[interruptRun] workflow-run cancel cascade failed for run=${waiter.runId}`,
            err,
            {
              tenantId: params.tenantId,
              parentRunId: params.runId,
              workflowRunId: waiter.runId,
            },
          );
        }
      }
    }

    return { status: resultStatus };
  };
}
