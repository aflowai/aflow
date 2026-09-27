import type { Redis } from 'ioredis';
import { isSlowBlockingRead } from '@aflow/lib';
import type { SessionId, TenantId } from '@aflow/schemas';
import {
  WORKFLOW_HARNESS_ADVANCE_GROUP,
  WORKFLOW_HARNESS_ADVANCE_STREAM,
  parseWorkflowHarnessAdvanceFields,
  type WorkflowHarnessAdvanceMessage,
} from '@aflow/cybernetic-runtime';
import { streamIdToTimestampMs, type BlockingRedisConnection } from '@aflow/redis';
import { getOrchestratorLogger } from '../../lib/orchestratorLogger.js';
import type { HarnessDeps } from './harness/types.js';

const ADVANCE_BLOCK_MS = 100;

async function dispatchInterruptRetry(
  harnessDeps: HarnessDeps,
  tenantId: TenantId,
  message: WorkflowHarnessAdvanceMessage,
): Promise<void> {
  if (!message.taskId) return;
  const { loadRunByRunIdAcrossSpaces } = await import('./harness/helpers.js');
  const run = await loadRunByRunIdAcrossSpaces(
    harnessDeps.db,
    tenantId as string,
    message.workflowRunId,
  );
  if (!run?.sessionId) return;
  const task = run.tasks.find((t) => t.taskId === message.taskId);
  if (task?.status !== 'running') return;
  const { dispatchRetriedTask } = await import('./WorkflowRunHarness.js');
  await dispatchRetriedTask(harnessDeps, {
    tenantId,
    runId: message.workflowRunId,
    taskId: message.taskId,
    attempt: task.attempt,
    helmsmanSessionId: run.sessionId as SessionId,
  });
}

const CONSUMER_NAME = `harness-advance-${process.pid}`;

export interface WorkflowHarnessAdvanceConsumer {
  stop: () => Promise<void>;
}

export async function startWorkflowHarnessAdvanceConsumer(deps: {
  redis: Redis;
  blockingRedis: BlockingRedisConnection;
  harnessDeps: HarnessDeps;
}): Promise<WorkflowHarnessAdvanceConsumer> {
  const log = getOrchestratorLogger().child({ component: 'workflowHarnessAdvanceConsumer' });
  const { blockingRedis, harnessDeps } = deps;
  let running = true;

  try {
    await blockingRedis.xgroup(
      'CREATE',
      WORKFLOW_HARNESS_ADVANCE_STREAM,
      WORKFLOW_HARNESS_ADVANCE_GROUP,
      '0',
      'MKSTREAM',
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('BUSYGROUP')) throw err;
  }

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        const readStart = Date.now();
        const result = (await blockingRedis.xreadgroup(
          'GROUP',
          WORKFLOW_HARNESS_ADVANCE_GROUP,
          CONSUMER_NAME,
          'COUNT',
          10,
          'BLOCK',
          ADVANCE_BLOCK_MS,
          'STREAMS',
          WORKFLOW_HARNESS_ADVANCE_STREAM,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;
        const xreadElapsedMs = Date.now() - readStart;

        if (!running) {
          break;
        }

        if (!result) {
          if (isSlowBlockingRead(xreadElapsedMs, ADVANCE_BLOCK_MS)) {
            log.warn('[PERF] hot_path_consumer_slow_read', {
              component: 'workflow-harness-advance-consumer',
              xreadElapsedMs: String(xreadElapsedMs),
              blockMs: String(ADVANCE_BLOCK_MS),
              entriesRead: '0',
            });
          }
          continue;
        } else {
          let maxAgeMs = 0;
          let totalEntries = 0;
          const now = Date.now();
          for (const [, entries] of result) {
            for (const [id] of entries) {
              totalEntries += 1;
              const ts = streamIdToTimestampMs(id);
              if (ts !== null) {
                const age = now - ts;
                if (age > maxAgeMs) maxAgeMs = age;
              }
            }
          }
          if (maxAgeMs > 250) {
            log.warn('[PERF] hot_path_consumer_slow_read', {
              component: 'workflow-harness-advance-consumer',
              xreadElapsedMs: String(xreadElapsedMs),
              blockMs: String(ADVANCE_BLOCK_MS),
              entriesRead: String(totalEntries),
              messageAgeMsMax: String(maxAgeMs),
            });
          }
        }

        for (const [, entries] of result) {
          for (const [id, rawFields] of entries) {
            const fieldObj: Record<string, string> = {};
            for (let i = 0; i < rawFields.length; i += 2) {
              const key = rawFields[i];
              const value = rawFields[i + 1];
              if (key !== undefined && value !== undefined) fieldObj[key] = value;
            }
            const message = parseWorkflowHarnessAdvanceFields(fieldObj);
            if (!message) {
              await deps.redis.xack(
                WORKFLOW_HARNESS_ADVANCE_STREAM,
                WORKFLOW_HARNESS_ADVANCE_GROUP,
                id,
              );
              continue;
            }
            try {
              const tenantId = message.tenantId as TenantId;
              if (message.action === 'cancel') {
                const { cancelRun } = await import('./harness/cancel.js');
                await cancelRun(harnessDeps, tenantId, message.workflowRunId, {
                  ...(message.cancelledBy ? { cancelledBy: message.cancelledBy } : {}),
                  ...(message.reason ? { reason: message.reason } : {}),
                });
              } else if (message.action === 'retry_dispatch' && message.taskId) {
                await dispatchInterruptRetry(harnessDeps, tenantId, message);
              } else if (message.failedTaskId) {
                const { applyFailureMode } = await import('./harness/pauseResume.js');
                await applyFailureMode(
                  harnessDeps,
                  tenantId,
                  message.workflowRunId,
                  message.failedTaskId,
                );
              } else {
                const { dispatchNextOrTerminate } = await import('./harness/dispatch.js');
                await dispatchNextOrTerminate(harnessDeps, tenantId, message.workflowRunId);
              }
              await deps.redis.xack(
                WORKFLOW_HARNESS_ADVANCE_STREAM,
                WORKFLOW_HARNESS_ADVANCE_GROUP,
                id,
              );
            } catch (err) {
              log.warn(
                `[workflowHarnessAdvanceConsumer] advance failed run=${message.workflowRunId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      } catch (err) {
        log.warn(
          `[workflowHarnessAdvanceConsumer] read loop error: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };

  const loopPromise = loop();

  return {
    stop: async () => {
      running = false;
      await loopPromise.catch(() => {
        /* loop errors already logged in-line */
      });
    },
  };
}
