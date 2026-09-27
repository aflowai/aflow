import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  StreamKeys,
  type StepExecutionId,
  type WorkflowRunUpdatePayload,
  type WorkflowTaskUpdatePayload,
  type WorkflowTaskActivityPayload,
  type WorkflowTaskSurfaceUpdatePayload,
  type WorkflowRunTaskStatus,
  type LiveDeltaChannel,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { appendSessionEvent, publishLiveDeltaWake, type SessionEvent } from '@aflow/redis';
import { loadPendingWaiters, loadRunOriginatingSessionId } from './ledger.js';
import { buildWorkflowRunDetail } from './workflowRunDetail.js';

export type WorkflowProgressEvent =
  | { kind: 'WorkflowRunUpdate'; payload: WorkflowRunUpdatePayload }
  | { kind: 'WorkflowTaskUpdate'; payload: WorkflowTaskUpdatePayload }
  | { kind: 'WorkflowTaskActivity'; payload: WorkflowTaskActivityPayload }
  | { kind: 'WorkflowTaskSurfaceUpdate'; payload: WorkflowTaskSurfaceUpdatePayload };

export interface EmitWorkflowProgressDeps {
  db: PostgresJsDatabase;
  redis: Redis;
}

export interface EmitWorkflowProgressArgs {
  tenantId: string;
  runId: string;
  event: WorkflowProgressEvent;
  excludeSessionIds?: string[];
}

/**
 * Fan out a workflow-progress event to every chat session currently waiting
 * on the run. Each waiter session gets its own SessionEvent (unique
 * `eventId`, the waiter's `sessionId` stamped on the event) appended to
 * its events stream.
 *
 * No-op when there are no pending waiters — the run is still executing but
 * no chat is parked on it, so there's nobody to notify. The reducer's
 * subscribe-time catch-up (§4.1.4) re-derives state when a new chat
 * eventually subscribes.
 *
 * Live emissions intentionally **omit** `waiterStepExecutionId` on
 * `WorkflowRunUpdate` payloads — passing an anchor through this path would
 * cause the chat reducer's Mount-Rule-B to fire on every live transition,
 * creating spurious render-items. Catch-up paths inject the anchor
 * separately (see `buildSessionCatchupEvents`).
 */
export async function emitWorkflowProgress(
  deps: EmitWorkflowProgressDeps,
  args: EmitWorkflowProgressArgs,
): Promise<void> {
  // Fan workflow events out to both
  // currently-parked waiter sessions AND the run's originating chat
  // session, deduped. Checking waiters only and
  // bailing when none are parked leaves a real gap: after Helmsman
  // wakes on a HITL pause and ends its turn (per the prompt's "When the
  // operator resolves directly" rule), it's no longer a waiter — so
  // operator-driven resume + subsequent task transitions would never reach
  // the chat UI, and the run-surface card would sit stale until refresh. The
  // observation channel (chat UI subscribed to the originating session's
  // event stream) is conceptually separate from the execution channel
  // (waiters that get woken to act). Including the originating session
  // here closes the observability gap without changing waiter semantics.
  //
  // Two DB queries on the hot path — both indexed PK lookups. The
  // originating session is stable per run, so a future memo (Redis or
  // process-local) is a reasonable optimisation if profiling flags it.
  const [allWaiters, originatingSessionId] = await Promise.all([
    loadPendingWaiters(deps.db, args.tenantId, args.runId),
    loadRunOriginatingSessionId(deps.db, args.tenantId, args.runId),
  ]);

  const excludeSet = new Set(args.excludeSessionIds ?? []);
  const targetSessions = new Set<string>();
  for (const w of allWaiters) {
    if (!excludeSet.has(w.waiterSessionId)) targetSessions.add(w.waiterSessionId);
  }
  if (originatingSessionId && !excludeSet.has(originatingSessionId)) {
    targetSessions.add(originatingSessionId);
  }
  if (targetSessions.size === 0) return;

  // Strip `waiterStepExecutionId` from any WorkflowRunUpdate payload the
  // caller passed in — live emissions must never carry the catch-up
  // anchor. This is a belt-and-suspenders guard; harness call sites
  // should already omit the field, and the type system encourages it.
  const eventTypeStamp = args.event.kind;
  const payloadFields: {
    workflowRunUpdate?: WorkflowRunUpdatePayload;
    workflowTaskUpdate?: WorkflowTaskUpdatePayload;
    workflowTaskActivity?: WorkflowTaskActivityPayload;
    workflowTaskSurfaceUpdate?: WorkflowTaskSurfaceUpdatePayload;
  } =
    args.event.kind === 'WorkflowRunUpdate'
      ? { workflowRunUpdate: stripCatchupAnchor(args.event.payload) }
      : args.event.kind === 'WorkflowTaskUpdate'
        ? { workflowTaskUpdate: args.event.payload }
        : args.event.kind === 'WorkflowTaskActivity'
          ? { workflowTaskActivity: args.event.payload }
          : { workflowTaskSurfaceUpdate: args.event.payload };

  const nowMs = Date.now();

  // Per-session catch: a single Redis blip writing to one session's stream
  // must not abort fan-out to the rest. Without this, an early-loop
  // failure leaves later targets receiving the synthetic step result
  // WITHOUT the preceding workflow update — the exact ordering the
  // §4.2 invariant exists to prevent. Each append runs independently;
  // failures are logged and the loop continues.
  await Promise.allSettled(
    [...targetSessions].map(async (sessionId) => {
      const event: SessionEvent = {
        eventId: randomUUID(),
        eventType: eventTypeStamp,
        timestamp: nowMs,
        sessionId,
        ...payloadFields,
      };
      try {
        await appendSessionEvent(deps.redis, args.tenantId, sessionId, event);
      } catch (err: unknown) {
        // Best-effort per session. Caller's wrapping catch only sees a
        // success here so the run-advance path proceeds for the
        // remaining targets.

        console.warn(
          `[emitWorkflowProgress] appendSessionEvent failed for session=${sessionId} run=${args.runId} kind=${eventTypeStamp}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );
}

/**
 * Wake every session watching a run so it re-reads a step's live buffer.
 *
 * The audience is the one `emitWorkflowProgress` fans out to — the parked
 * waiters and the run's originating chat — but nothing durable is written. A
 * delta is a value superseded by its step's terminal event, and appending one
 * per flush would spend the session event stream's bounded capacity on text
 * that is never replayed. A step a workflow dispatched has no session of its
 * own, so this is the only way its buffer reaches a reader.
 */
export async function publishWorkflowLiveDeltaWake(
  deps: EmitWorkflowProgressDeps,
  args: { tenantId: string; runId: string; channel: LiveDeltaChannel },
): Promise<void> {
  const [waiters, originatingSessionId] = await Promise.all([
    loadPendingWaiters(deps.db, args.tenantId, args.runId),
    loadRunOriginatingSessionId(deps.db, args.tenantId, args.runId),
  ]);
  const targets = new Set(waiters.map((w) => w.waiterSessionId));
  if (originatingSessionId) targets.add(originatingSessionId);
  await publishLiveDeltaWake(deps.redis, args.tenantId, [...targets], args.channel);
}

/**
 * Emit a live `WorkflowTaskUpdate(skipped)` for each task a rejected approval
 * skipped (the gated-branch descendants). The `reject` commit pre-inserts these
 * skipped rows inside its transaction, so the `dispatchNext` skip-loop — which
 * only emits for tasks IT newly skips — never surfaces them. Without this the
 * run-surface keeps rendering them as forward-DAG ghosts ("waiting on N") until
 * a detail refetch. Mirrors the per-skip emit in `dispatchNextOrTerminate`.
 *
 * Best-effort: a per-task emit failure is logged and skipped, never thrown —
 * the rows are already durably `skipped`, and the next refetch reconciles.
 */
export async function emitRejectedBranchSkips(
  deps: EmitWorkflowProgressDeps,
  args: {
    tenantId: string;
    runId: string;
    /** taskId → display label for the skipped descendants. */
    skipped: Array<{ taskId: string; label: string }>;
  },
): Promise<void> {
  for (const { taskId, label } of args.skipped) {
    await emitWorkflowProgress(deps, {
      tenantId: args.tenantId,
      runId: args.runId,
      event: {
        kind: 'WorkflowTaskUpdate',
        payload: {
          runId: args.runId,
          taskId,
          label,
          status: 'skipped',
          attempt: 1,
          completedAt: new Date().toISOString(),
          summary: 'Skipped — upstream approval rejected.',
        },
      },
    }).catch((err: unknown) => {
      console.warn(
        `[emitRejectedBranchSkips] emit WorkflowTaskUpdate(skipped) failed for task=${taskId} run=${args.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}

/**
 * Drop the `waiterStepExecutionId` from a live WorkflowRunUpdate payload.
 * The field is shape-typed optional, so passing it through would silently
 * cause the chat reducer to mount fresh surface items on every live
 * transition — a bug class subtle enough to deserve a centralized guard.
 */
function stripCatchupAnchor(payload: WorkflowRunUpdatePayload): WorkflowRunUpdatePayload {
  if (payload.waiterStepExecutionId === undefined) return payload;
  const { waiterStepExecutionId: _stripped, ...rest } = payload;
  return rest;
}

export async function emitCatchupToNewWaiter(
  deps: { db: PostgresJsDatabase; redis: Redis; payloadStore: PayloadStore },
  args: {
    tenantId: string;
    spaceId: string;
    runId: string;
    waiterSessionId: string;
    waiterStepExecutionId: string;
  },
): Promise<number> {
  const detail = await buildWorkflowRunDetail(
    deps.db,
    deps.payloadStore,
    args.tenantId,
    args.spaceId,
    args.runId,
  );
  if (!detail) return 0;

  const nowMs = Date.now();
  let emitted = 0;

  // Run update (with the catch-up mount anchor — the one path where the
  // anchor IS load-bearing).
  const runEvent: SessionEvent = {
    eventId: randomUUID(),
    eventType: 'WorkflowRunUpdate',
    timestamp: nowMs,
    sessionId: args.waiterSessionId,
    workflowRunUpdate: {
      runId: detail.run.runId,
      slug: detail.run.workflowSlug,
      ...(detail.run.workflowTitle ? { workflowTitle: detail.run.workflowTitle } : {}),
      status: detail.run.status,
      pauseVersion: detail.run.pauseVersion,
      ...(detail.run.pausedReason ? { pausedReason: detail.run.pausedReason } : {}),
      startedAt: detail.run.startedAt,
      ...(detail.run.completedAt ? { completedAt: detail.run.completedAt } : {}),
      waiterStepExecutionId: args.waiterStepExecutionId,
    },
  };
  await appendSessionEvent(deps.redis, args.tenantId, args.waiterSessionId, runEvent);
  emitted++;

  // Per-task updates for non-terminal tasks. Terminal task rows are
  // historical context — the reducer derives them on-demand via the BFF
  // detail fetch if the user expands the surface, so we don't burn
  // stream slots on them at registration.
  const TERMINAL_TASK_STATUSES: ReadonlySet<WorkflowRunTaskStatus> = new Set([
    'succeeded',
    'failed',
    'cancelled',
    'skipped',
  ]);
  for (const task of detail.tasks) {
    if (TERMINAL_TASK_STATUSES.has(task.status)) continue;
    const taskEvent: SessionEvent = {
      eventId: randomUUID(),
      eventType: 'WorkflowTaskUpdate',
      timestamp: nowMs,
      sessionId: args.waiterSessionId,
      workflowTaskUpdate: {
        runId: detail.run.runId,
        taskId: task.taskId,
        label: task.label,
        status: task.status,
        attempt: task.attempt,
        ...(task.workerSessionId ? { workerSessionId: task.workerSessionId } : {}),
        ...(task.operationId ? { operationId: task.operationId } : {}),
        ...(task.taskType ? { taskType: task.taskType } : {}),
        ...(task.startedAt ? { startedAt: task.startedAt } : {}),
        ...(task.completedAt ? { completedAt: task.completedAt } : {}),
        ...(task.failureReason ? { failureReason: task.failureReason } : {}),
        ...(task.summary ? { summary: task.summary } : {}),
        ...(task.humanIntent ? { humanIntent: task.humanIntent } : {}),
      },
    };
    await appendSessionEvent(deps.redis, args.tenantId, args.waiterSessionId, taskEvent);
    emitted++;

    try {
      const surfaceEvent = await synthesizeSurfaceCatchupEvent(
        deps.redis,
        args.tenantId,
        args.waiterSessionId,
        detail.run.runId,
        task.taskId,
        nowMs,
      );
      if (surfaceEvent) {
        await appendSessionEvent(deps.redis, args.tenantId, args.waiterSessionId, surfaceEvent);
        emitted++;
      }
    } catch (err) {
      console.warn(
        `[emitCatchupToNewWaiter] surface catch-up failed task=${task.taskId} run=${detail.run.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return emitted;
}

export async function aggregateSurfaceStreamPayload(
  redis: Redis,
  tenantId: string,
  runId: string,
  taskId: string,
): Promise<WorkflowTaskSurfaceUpdatePayload | null> {
  const streamKey = StreamKeys.workflowTaskProgressStream(tenantId, runId, taskId);
  const entries = (await redis.xrange(streamKey, '-', '+')) as Array<[string, string[]]>;
  if (entries.length === 0) return null;

  // Pass 1: parse each entry's fields and find the latest stepExecutionId.
  // XRANGE returns entries in monotonic id order (XADD assigns strictly
  // increasing ids), so iterating top-down naturally yields the most
  // recent attempt last.
  const parsedEntries: Array<Record<string, string>> = [];
  let latestStepExecutionId: string | undefined;
  for (const [_id, fieldPairs] of entries) {
    const fields: Record<string, string> = {};
    for (let i = 0; i + 1 < fieldPairs.length; i += 2) {
      fields[fieldPairs[i]!] = fieldPairs[i + 1]!;
    }
    parsedEntries.push(fields);
    if (fields['stepExecutionId']) {
      latestStepExecutionId = fields['stepExecutionId'];
    }
  }
  if (!latestStepExecutionId) return null;

  // Pass 2: aggregate only the latest attempt's entries. Older entries
  // are dropped — they came from a prior attempt whose stream wasn't
  // cleaned up. Reducer keys retry-boundary on stepExecutionId, so the
  // synthesized event must reflect exactly one attempt.
  const allMutations: Array<Record<string, unknown>> = [];
  let surfaceId: string | undefined;
  let lastSequence = 0;
  for (const fields of parsedEntries) {
    if (fields['stepExecutionId'] !== latestStepExecutionId) continue;
    surfaceId ??= fields['surfaceId'];
    const seq = Number(fields['sequence'] ?? '0');
    if (Number.isFinite(seq) && seq > lastSequence) lastSequence = seq;
    const mutationsRaw = fields['surfaceMutations'];
    if (!mutationsRaw) continue;
    try {
      const batch = JSON.parse(mutationsRaw) as Array<Record<string, unknown>>;
      allMutations.push(...batch);
    } catch {
      /* skip malformed */
    }
  }

  if (!surfaceId || allMutations.length === 0) return null;

  return {
    runId,
    taskId,
    stepExecutionId: latestStepExecutionId as StepExecutionId,
    surfaceId,
    surfaceMutations: allMutations,
    sequence: lastSequence,
  };
}

export async function drainSurfaceStreamToWaiters(
  deps: EmitWorkflowProgressDeps,
  args: { tenantId: string; runId: string; taskId: string },
): Promise<void> {
  const payload = await aggregateSurfaceStreamPayload(
    deps.redis,
    args.tenantId,
    args.runId,
    args.taskId,
  );
  if (!payload) return;
  await emitWorkflowProgress(deps, {
    tenantId: args.tenantId,
    runId: args.runId,
    event: { kind: 'WorkflowTaskSurfaceUpdate', payload },
  });
}

async function synthesizeSurfaceCatchupEvent(
  redis: Redis,
  tenantId: string,
  waiterSessionId: string,
  runId: string,
  taskId: string,
  nowMs: number,
): Promise<SessionEvent | null> {
  const payload = await aggregateSurfaceStreamPayload(redis, tenantId, runId, taskId);
  if (!payload) return null;
  return {
    eventId: randomUUID(),
    eventType: 'WorkflowTaskSurfaceUpdate',
    timestamp: nowMs,
    sessionId: waiterSessionId,
    workflowTaskSurfaceUpdate: payload,
  };
}
