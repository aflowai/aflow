import { emitWorkflowProgress, loadWorkflowTaskByWorkerSession } from '@aflow/cybernetic-runtime';
import { logOrchestratorError } from '../../../lib/orchestratorLogger.js';
import type { SessionOrchestratorBindings } from '../lifecycle/context.js';

export const ACTIVITY_RELAY_THROTTLE_MS = 500;

export function createRelayWorkflowTaskActivity(bindings: SessionOrchestratorBindings) {
  const { deps, relayActivity } = bindings;
  const { db, redis } = deps;
  const activityRelayThrottle = relayActivity.throttle;

  return async function relayWorkflowTaskActivity(
    tenantId: string,
    workerSessionId: string,
    operationId: string,
    stepName: string | undefined,
    stepDetail: string | undefined,
  ): Promise<void> {
    try {
      const task = await loadWorkflowTaskByWorkerSession(db, tenantId, workerSessionId);
      if (!task) return; // not a workflow worker session — common case
      // Throttle key includes attempt so a retried task gets a fresh
      // sequence counter (the reducer keys by (taskId, attempt) too).
      const throttleKey = `${task.runId}:${task.taskId}:${String(task.attempt)}`;
      const prev = activityRelayThrottle.get(throttleKey);
      const now = Date.now();
      if (
        prev?.lastOp === operationId &&
        now - ((prev.lastEmitAtMs as number | undefined) ?? 0) < ACTIVITY_RELAY_THROTTLE_MS
      ) {
        return; // same-op within throttle window — suppress
      }
      const nextSequence = (prev?.sequence ?? 0) + 1;
      activityRelayThrottle.set(throttleKey, {
        lastEmitAtMs: now,
        lastOp: operationId,
        sequence: nextSequence,
      });
      await emitWorkflowProgress(
        { db, redis },
        {
          tenantId,
          runId: task.runId,
          event: {
            kind: 'WorkflowTaskActivity',
            payload: {
              runId: task.runId,
              taskId: task.taskId,
              operationId,
              ...(stepName ? { stepName } : {}),
              ...(stepDetail ? { stepDetail } : {}),
              workerSessionId,
              sequence: nextSequence,
            },
          },
        },
      );
    } catch (err) {
      logOrchestratorError(
        `[relayWorkflowTaskActivity] best-effort relay failed for sessionId=${workerSessionId}`,
        err,
        { tenantId, workerSessionId, operationId },
      );
    }
  };
}
