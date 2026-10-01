import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import {
  aggregateSurfaceStreamPayload,
  buildWorkflowRunDetail,
  loadPendingWaitersForSession,
} from '@aflow/cybernetic-runtime';
import type { ApiSessionEvent, SessionId, WorkflowRunTaskStatus } from '@aflow/schemas';

/** Max number of active runs emitted in a single subscribe catch-up burst. */
export const MAX_CATCHUP_RUNS = 10;

/** Max number of per-task updates emitted per run in catch-up. */
export const MAX_CATCHUP_TASKS_PER_RUN = 25;

/**
 * Build the set of catch-up events for a chat session at subscribe time.
 *
 * Returns events in emission order: one `WorkflowRunUpdate` per waited-on
 * run (with `waiterStepExecutionId` populated for catch-up mount anchoring),
 * followed by up to `MAX_CATCHUP_TASKS_PER_RUN` `WorkflowTaskUpdate` events
 * for that run's tasks. Each event has `metadata.catchup: true` so the
 * reducer can distinguish them (it treats them identically to live events,
 * but the flag is useful for logging/telemetry).
 *
 * Empty array if the session has no active waiters — no extra work; the
 * regular stream continues as today.
 */
export async function buildSessionCatchupEvents(
  db: PostgresJsDatabase,
  payloadStore: PayloadStore,
  tenantId: string,
  sessionId: SessionId,
  spaceId: string,
  redis?: Redis | null,
): Promise<{ events: ApiSessionEvent[]; runsTruncated: boolean; tasksTruncated: number }> {
  const allWaiters = await loadPendingWaitersForSession(db, tenantId, sessionId as string);
  if (allWaiters.length === 0) {
    return { events: [], runsTruncated: false, tasksTruncated: 0 };
  }

  const runsTruncated = allWaiters.length > MAX_CATCHUP_RUNS;
  const waiters = allWaiters.slice(0, MAX_CATCHUP_RUNS);

  const events: ApiSessionEvent[] = [];
  let tasksTruncated = 0;

  for (const waiter of waiters) {
    const detail = await buildWorkflowRunDetail(db, payloadStore, tenantId, spaceId, waiter.runId);
    if (!detail) continue; // run vanished between waiter row and now — skip

    const runTaskCount = detail.tasks.length;
    const truncatedThisRun = runTaskCount > MAX_CATCHUP_TASKS_PER_RUN;
    if (truncatedThisRun) tasksTruncated++;

    const baseMetadata: Record<string, unknown> = { catchup: true };
    if (runsTruncated) baseMetadata['runsTruncated'] = true;

    const runMetadata: Record<string, unknown> = { ...baseMetadata };
    if (truncatedThisRun) runMetadata['tasksTruncated'] = true;

    const nowIso = new Date().toISOString();

    // Run-level update first — carries the waiterStepExecutionId mount anchor.
    events.push({
      eventId: crypto.randomUUID(),
      eventType: 'WorkflowRunUpdate',
      sessionId,
      timestamp: nowIso,
      sequenceNumber: 0,
      eventVersion: 1,
      data: {
        workflowRunUpdate: {
          runId: detail.run.runId,
          slug: detail.run.workflowSlug,
          ...(detail.run.workflowTitle ? { workflowTitle: detail.run.workflowTitle } : {}),
          status: detail.run.status,
          pauseVersion: detail.run.pauseVersion,
          ...(detail.run.pausedReason ? { pausedReason: detail.run.pausedReason } : {}),
          startedAt: detail.run.startedAt,
          ...(detail.run.completedAt ? { completedAt: detail.run.completedAt } : {}),
          ...(waiter.waiterStepExecutionId
            ? { waiterStepExecutionId: waiter.waiterStepExecutionId }
            : {}),
        },
      },
      metadata: runMetadata,
    });

    // Then per-task updates, capped + ordered (terminal first so the UI shows
    // completed work even on truncation, then in-flight, then pending).
    const orderedTasks = [...detail.tasks].sort(
      (a, b) => terminalRank(a.status) - terminalRank(b.status),
    );
    const tasksToEmit = orderedTasks.slice(0, MAX_CATCHUP_TASKS_PER_RUN);

    for (const task of tasksToEmit) {
      const taskMetadata: Record<string, unknown> = { catchup: true };
      if (truncatedThisRun) taskMetadata['truncated'] = true;
      if (runsTruncated) taskMetadata['runsTruncated'] = true;
      events.push({
        eventId: crypto.randomUUID(),
        eventType: 'WorkflowTaskUpdate',
        sessionId,
        timestamp: nowIso,
        sequenceNumber: 0,
        eventVersion: 1,
        data: {
          workflowTaskUpdate: {
            runId: detail.run.runId,
            taskId: task.taskId,
            label: task.label,
            status: task.status,
            attempt: task.attempt,
            ...(task.workerSessionId ? { workerSessionId: task.workerSessionId } : {}),
            ...(task.operationId ? { operationId: task.operationId } : {}),
            ...(task.startedAt ? { startedAt: task.startedAt } : {}),
            ...(task.completedAt ? { completedAt: task.completedAt } : {}),
            ...(task.failureReason ? { failureReason: task.failureReason } : {}),
            ...(task.summary ? { summary: task.summary } : {}),
            ...(task.humanIntent ? { humanIntent: task.humanIntent } : {}),
            ...(task.resolutionSchema ? { resolutionSchema: task.resolutionSchema } : {}),
            ...(task.actionPreview ? { actionPreview: task.actionPreview } : {}),
            ...(task.pauseVersion !== undefined ? { pauseVersion: task.pauseVersion } : {}),
            ...(task.failureMode ? { failureMode: task.failureMode } : {}),
          },
        },
        metadata: taskMetadata,
      });

      if (redis && !isTerminalTaskStatus(task.status)) {
        try {
          const surfacePayload = await aggregateSurfaceStreamPayload(
            redis,
            tenantId,
            detail.run.runId,
            task.taskId,
          );
          if (surfacePayload) {
            events.push({
              eventId: crypto.randomUUID(),
              eventType: 'WorkflowTaskSurfaceUpdate',
              sessionId,
              timestamp: nowIso,
              sequenceNumber: 0,
              eventVersion: 1,
              data: { workflowTaskSurfaceUpdate: surfacePayload },
              metadata: { ...taskMetadata },
            });
          }
        } catch {
          /* best-effort — failure here leaves the surface empty until
             the next live mutation; the rest of catch-up still works. */
        }
      }
    }
  }

  return { events, runsTruncated, tasksTruncated };
}

function isTerminalTaskStatus(status: WorkflowRunTaskStatus): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'skipped'
  );
}

/**
 * Ordering for task-row catch-up emission under truncation: emit terminal
 * tasks first (succeeded/failed), then in-flight (running/paused), then
 * pending (scheduled/blocked). Within a category, original order is
 * preserved (Array.sort is stable in modern Node). This way the surface
 * shows completed work even when the list is truncated.
 */
function terminalRank(status: string): number {
  switch (status) {
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'skipped':
      return 0;
    case 'running':
    case 'paused':
      return 1;
    default:
      return 2;
  }
}
