import type { Redis } from 'ioredis';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantId } from '@aflow/schemas';
import { StreamKeys, targetToColumns } from '@aflow/schemas';
import type { ManifestService } from './ManifestService.js';
import { recordProjectionLag } from '@aflow/observability';
import { eq, sql } from 'drizzle-orm';
import {
  getSessionStateSafe,
  claimProjectionCandidates,
  ackProjection,
  dropProjectionCandidate,
  dropProjectionCandidateIfVersion,
  readDurableEventEntries,
  compareStreamIds,
  deleteRecoveryData,
  publishActionCenterWake,
  type ProjectionCandidate,
  type SessionHotState,
  type SessionEvent,
} from '@aflow/redis';
import { createLeasedWorkConsumer, type LeasedWorkResult } from '@aflow/lib';
import { bumpAttentionGeneration, endsConversationOwnership } from '@aflow/cybernetic-runtime';
import {
  createTenantContext,
  withTenantSchema,
  sessions,
  eventLog,
  recordProjectionFailure,
  clearProjectionFailure,
  type ProjectionFailureReason,
} from '@aflow/database';
import { buildHotStateSnapshot } from './hotStateSnapshot.js';
import {
  routePauseNotifications,
  type PauseNotificationPayloadRetriever,
} from './pauseNotificationRouter.js';
import { getOrchestratorLogger, logOrchestratorError } from '../lib/orchestratorLogger.js';
import { assembleErrorReport } from './errorReportAssembly.js';
import { toDateSafe } from '../lib/toDateSafe.js';
import type { CompletionScheduleRecorder } from './ScheduleEvaluator.js';

// ============================================================================
// Types
// ============================================================================

export interface ProjectionWorkerConfig {
  /** How often to claim due candidates (ms). Default: 3000 */
  intervalMs?: number;
  /** Max runs to process per cycle. Default: 50 */
  batchSize?: number;
}

export interface ProjectionWorkerDeps {
  redis: Redis;
  db: PostgresJsDatabase;
  /**
   * Where a failure is recorded before its candidate is dropped. Without it
   * nothing is ever evicted — an untraceable drop is the outcome the record
   * exists to prevent, and a poison candidate retried forever is the cheaper
   * failure.
   */
  sqlClient?: postgres.Sql;
  manifestService?: ManifestService;
  payloadStore?: PauseNotificationPayloadRetriever;
  /**
   * Records `on_completion` occurrences once the terminal run is durable.
   * Projection is the one place guaranteed to see every terminal transition,
   * whichever writer produced it — some reach terminal without going through
   * the step lifecycle at all.
   */
  completionSchedules?: CompletionScheduleRecorder;
}

export interface ProjectionWorker {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  /** Run one cycle now, outside the schedule. Used by tests and operator tools. */
  runOnce(): Promise<ProjectionCycleStats>;
  /** Metrics: runs projected in last cycle */
  lastCycleStats(): ProjectionCycleStats;
}

export interface ProjectionCycleStats {
  /** Candidates claimed this cycle */
  candidateCount: number;
  /** Runs projected (terminal + non-terminal) */
  projectedCount: number;
  /** Terminal runs fully flushed */
  flushedCount: number;
  /** Non-terminal runs status-upserted */
  statusUpdatedCount: number;
  /** Errors during projection */
  errorCount: number;
  /** Candidates dropped, each with a durable failure record behind it */
  evictedCount: number;
  /**
   * Failures that could not be recorded, so the candidate stayed armed. This is
   * the shape a Postgres outage takes here, and it is not the same event as an
   * eviction.
   */
  unrecordedFailureCount: number;
  /**
   * Acknowledgements refused because the session changed mid-projection. Sound
   * on its own; every cycle in a row is a session being reprojected forever.
   */
  ackRefusedCount: number;
  /** Time taken for last cycle (ms) */
  cycleMs: number;
}

// Terminal states get full flush (events + clear dirty + manifest)
const TERMINAL_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
// Flushable states include PAUSED/WAITING_ON_CHILD/STALLED (need Postgres visibility)
const FLUSHABLE_STATES = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'PAUSED',
  'WAITING_ON_CHILD',
  'STALLED',
]);

/**
 * Failures a session may accumulate before its candidate is dropped. Counted on
 * the durable record, so the ceiling means the same thing across a restart and
 * across instances.
 */
const MAX_PROJECTION_RETRIES = 10;

/**
 * A session with no readable hot state has nothing to project from, so there is
 * no later attempt that could go better — the first record is also the last.
 */
const EVICT_IMMEDIATELY = 1;

/**
 * One XRANGE page of the event-tail flush. Sized to the stream's MAXLEN cap so
 * a flush is one page in the common case; the loop pages until the stream is
 * exhausted, so neither bound caps what gets persisted.
 */
const EVENT_FLUSH_PAGE = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * A completion-schedule failure wearing its own type so the projection's
 * eviction budget can decline to count it. The session's durable row is not at
 * fault and must not be given up on because another domain's write failed.
 */
class CompletionScheduleError extends Error {
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'CompletionScheduleError';
    if (cause) this.cause = cause;
  }
}

/**
 * A row for an event this process cannot parse — appended by a newer deploy
 * during a rollout, or by a newer branch on a shared dev Redis. Durability is
 * type-agnostic on purpose: the envelope carries everything, readers validate
 * at read time, and a flush that only persisted what its own vintage
 * understood would quietly discard the newest events in exactly the window a
 * deploy makes them likeliest.
 */
function toRawEventLogRow(
  envelope: Record<string, unknown>,
  now: Date,
): typeof eventLog.$inferInsert {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    eventId: envelope['eventId'] as string,
    eventType: envelope['eventType'] as string,
    sessionId: envelope['sessionId'] as string,
    stepExecutionId: str(envelope['stepExecutionId']),
    stepId: str(envelope['stepId']),
    stepType: str(envelope['stepType']),
    attempt: typeof envelope['attempt'] === 'number' ? envelope['attempt'] : undefined,
    timestamp: toDateSafe(envelope['timestamp'], now, 'event.raw.timestamp'),
    payloadRef: str(envelope['outputRef']),
    errorRef: str(envelope['errorRef']),
    idempotencyKey: `${envelope['eventId'] as string}:flushed`,
    envelope,
  };
}

/**
 * The conversation's activity clock, falling back to when it opened.
 *
 * A session that no person has spoken in has no conversational activity, but
 * it still has to sort somewhere — and sorting a whole column on
 * `COALESCE(last_activity_at, started_at)` needs an expression index to stay
 * fast and reads as two different clocks depending on the row's age. Writing
 * the fallback makes the column mean one thing: the last moment this session
 * was worth surfacing.
 */
function projectedActivityAt(runState: SessionHotState, now: Date): Date {
  if (runState.lastActivityAt !== undefined) {
    return toDateSafe(runState.lastActivityAt, now, 'session.lastActivityAt');
  }
  return toDateSafe(runState.startedAt ?? runState.createdAt, now, 'session.startedAt');
}

function toEventLogRow(event: SessionEvent, now: Date): typeof eventLog.$inferInsert {
  const operationId =
    event.metadata && typeof event.metadata === 'object'
      ? event.metadata['operationId']
      : undefined;
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    sessionId: event.sessionId,
    stepExecutionId: event.stepExecutionId,
    stepId: event.stepId,
    stepType: event.stepType,
    attempt: event.attempt,
    timestamp: toDateSafe(event.timestamp, now, `event.${event.eventType}.timestamp`),
    payloadRef: event.outputRef,
    errorRef: event.errorRef,
    idempotencyKey: `${event.eventId}:flushed`,
    envelope: event,
    ...(typeof operationId === 'string' ? { operationId } : {}),
  };
}

// ============================================================================
// Implementation
// ============================================================================

function emptyStats(): ProjectionCycleStats {
  return {
    candidateCount: 0,
    projectedCount: 0,
    flushedCount: 0,
    statusUpdatedCount: 0,
    errorCount: 0,
    evictedCount: 0,
    unrecordedFailureCount: 0,
    ackRefusedCount: 0,
    cycleMs: 0,
  };
}

export function createProjectionWorker(
  deps: ProjectionWorkerDeps,
  config: ProjectionWorkerConfig = {},
): ProjectionWorker {
  const { redis, db, sqlClient, manifestService, payloadStore, completionSchedules } = deps;
  const { intervalMs = 3000, batchSize = 50 } = config;
  const log = getOrchestratorLogger().child({ component: 'projection-worker' });

  let running = false;
  let stopRequested = false;
  let intervalHandle: NodeJS.Timeout | null = null;
  let stats: ProjectionCycleStats = emptyStats();

  // ── Durable event flush ─────────────────────────────────────────────────

  /**
   * Persist the session's event tail to event_log, from the durable cursor to
   * the end of the stream, and advance the cursor in the same transaction.
   *
   * The cursor lives on the session row so its advance commits atomically with
   * the inserts it accounts for — a failed insert throws, the transaction rolls
   * back cursor and rows together, and the unacknowledged candidate is
   * redelivered at lease expiry. A null cursor reads from the head of whatever
   * the stream still holds; the event_id conflict target absorbs the overlap
   * with rows flushed before the cursor existed.
   */
  async function flushDurableEvents(
    tx: PostgresJsDatabase,
    tenantId: string,
    runId: string,
  ): Promise<{ evictedGap: boolean }> {
    const [row] = await tx
      .select({ cursor: sessions.lastFlushedEventStreamId, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.sessionId, runId))
      .limit(1);

    const initialCursor = row?.cursor ?? '0';
    // A resting session was drained to the tail by the full flush that wrote
    // this cursor, in the same transaction — so nothing was pending behind it.
    // Resting is necessary but not sufficient: the durable row still reads
    // PAUSED for the cycle after a resume, and a session live again can trim
    // its recreated stream for real inside that window. A gone hot state is
    // what proves it never woke, so the two are read together and only their
    // conjunction downgrades the alarm.
    const restedAtCursor = row?.status != null && FLUSHABLE_STATES.has(row.status);
    let cursor = initialCursor;
    const now = new Date();
    let evictedGap = false;

    for (;;) {
      const { entries, lastId, oldestId } = await readDurableEventEntries(
        redis,
        tenantId,
        runId,
        cursor,
        EVENT_FLUSH_PAGE,
      );
      // Trimmed past the cursor means events left the stream without ever
      // becoming durable. Nothing can recover them; the one thing owed is that
      // the loss be visible rather than silently resumed over. Not written to
      // projection_failures — a later successful projection clears that row,
      // which would erase the only evidence.
      //
      // A session resting past the stream's own TTL opens the identical-looking
      // gap with nothing behind it: the key expires and the next append
      // recreates it with a fresh id. Reporting that as loss cries wolf on
      // every long human-approval wait, which is exactly when someone needs to
      // trust the alarm.
      if (
        !evictedGap &&
        cursor !== '0' &&
        oldestId !== null &&
        compareStreamIds(oldestId, cursor) > 0
      ) {
        evictedGap = true;
        const stateGone =
          restedAtCursor && (await redis.exists(StreamKeys.sessionStateKey(tenantId, runId))) === 0;
        if (stateGone) {
          log.info(
            `[ProjectionWorker] Session ${runId} event stream expired during a rest and was recreated at ${oldestId}; the cursor ${cursor} was the tail, so no events were pending`,
            { tenantId, runId, cursor, oldestId, status: row.status },
          );
        } else {
          log.error(
            `[ProjectionWorker] Session ${runId} event stream trimmed past the durable cursor — events between ${cursor} and ${oldestId} are lost`,
            undefined,
            { tenantId, runId, cursor, oldestId },
          );
        }
      }
      if (entries.length > 0) {
        await tx
          .insert(eventLog)
          .values(
            entries.map((entry) =>
              entry.event ? toEventLogRow(entry.event, now) : toRawEventLogRow(entry.envelope, now),
            ),
          )
          .onConflictDoNothing({ target: eventLog.eventId });
      }
      if (lastId === cursor) break;
      cursor = lastId;
    }

    if (cursor !== initialCursor) {
      await tx
        .update(sessions)
        .set({ lastFlushedEventStreamId: cursor })
        .where(eq(sessions.sessionId, runId));
    }
    return { evictedGap };
  }

  // ── Full flush (terminal runs) ──────────────────────────────────────────

  async function fullFlush(
    tenantId: string,
    runId: string,
    runState: SessionHotState,
  ): Promise<void> {
    const tenantContext = createTenantContext(tenantId as TenantId);
    const now = new Date();

    const targetCols1 = targetToColumns(runState.target);
    // A resting run needs its durable copy written here too: without the
    // snapshot, a run paused for longer than the Redis TTL cannot be resumed at
    // all, and the loss is silent until someone tries.
    const hotStateSnapshot = await buildHotStateSnapshot(redis, tenantId, runState);
    let fenceWon = false;
    await withTenantSchema(db, tenantContext, async (tx) => {
      const upserted = await tx
        .insert(sessions)
        .values({
          sessionId: runId,
          targetKind: targetCols1.targetKind,
          targetSystemRole: targetCols1.targetSystemRole,
          targetAgentId: targetCols1.targetAgentId,
          targetInlineDefRef: targetCols1.targetInlineDefRef,
          agentVersion: runState.agentVersion,
          status: runState.status,
          startStepId: runState.currentStepId,
          currentStepExecutionId: runState.currentStepExecutionId,
          finalOutputRef: runState.finalOutputRef,
          errorRef: runState.errorRef,
          pauseReason: runState.pauseReason,
          requestedInputRef: runState.requestedInputRef,
          createdBy: runState.createdBy,
          traceId: runState.traceId,
          ...(runState.spaceId ? { spaceId: runState.spaceId } : {}),
          ...(runState.parentSessionId ? { parentSessionId: runState.parentSessionId } : {}),
          startedAt: toDateSafe(runState.startedAt, now, 'session.startedAt'),
          endedAt:
            runState.endedAt == null ? null : toDateSafe(runState.endedAt, now, 'session.endedAt'),
          lastActivityAt: projectedActivityAt(runState, now),
          hotStateSnapshot,
          hotStateUpdatedAt: toDateSafe(runState.lastUpdatedAt, now, 'session.lastUpdatedAt'),
        })
        .onConflictDoUpdate({
          target: sessions.sessionId,
          set: {
            status: runState.status,
            currentStepExecutionId: runState.currentStepExecutionId,
            finalOutputRef: runState.finalOutputRef,
            errorRef: runState.errorRef,
            pauseReason: runState.pauseReason,
            requestedInputRef: runState.requestedInputRef,
            endedAt:
              runState.endedAt == null
                ? null
                : toDateSafe(runState.endedAt, now, 'session.endedAt'),
            lastActivityAt: projectedActivityAt(runState, now),
            hotStateSnapshot,
            hotStateUpdatedAt: toDateSafe(runState.lastUpdatedAt, now, 'session.lastUpdatedAt'),
            // The completion marker means "the CURRENT durable terminal state
            // has fired its schedules" — not "this session fired once, ever".
            // A session projected back into a live status (a retry reopening a
            // FAILED run) clears it, so the next terminal transition fires
            // instead of being swallowed by the previous one's mark.
            ...(TERMINAL_STATES.has(runState.status) ? {} : { completionSchedulesFiredAt: null }),
          },
          // Claim exclusivity ends at the Redis lease: a projector resuming
          // past its expired lease carries the older hot state it read, and
          // writing it would regress the durable status and clear the mark a
          // peer's newer projection stands behind. The fence skips the stale
          // write whole; the peer's write already carried the newer clock.
          setWhere: sql`${sessions.hotStateUpdatedAt} IS NULL OR ${sessions.hotStateUpdatedAt} <= excluded.hot_state_updated_at`,
        })
        .returning({ sessionId: sessions.sessionId });
      fenceWon = upserted.length > 0;
      if (fenceWon) await flushDurableEvents(tx, tenantId, runId);
    });

    if (!fenceWon) {
      // The fence rejected this write: a peer already projected newer state,
      // and everything below reasons from the stale state this claim read —
      // firing completions for it, deleting recovery data and manifest
      // entries a run projected live again still needs. The peer's own
      // projection carries those side effects for the state that won.
      getOrchestratorLogger().warn(
        `[ProjectionWorker] Stale terminal projection for run ${runId} lost the fence; skipping its side effects`,
        { tenantId, runId, status: runState.status },
      );
      return;
    }

    // The sessions row this flush just wrote is the only state the paused-step
    // action-center source reads, so this is the one place a pause (or its
    // resolution) becomes visible to operators. Published directly after the
    // fence: the side effects below can throw (deliberately — the candidate
    // must stay unacknowledged), and the row is already durable either way.
    if (runState.spaceId) {
      publishActionCenterWake(redis, {
        source: 'session_flush',
        tenantId,
        spaceId: runState.spaceId,
      });
      // The attention block reads whose a run is from this row, so a
      // conversation's end is a transition of every run it drove, and the
      // space's cached block is rebuilt for it as for a run's own.
      if (endsConversationOwnership(runState.target, runState.status)) {
        await bumpAttentionGeneration(redis, tenantId, runState.spaceId);
      }
    }

    // After the upsert, because the mark it claims lives on the row that upsert
    // writes; not swallowed, because a throw here leaves the candidate
    // unacknowledged and that is the whole recovery story for a lost firing.
    if (
      completionSchedules &&
      TERMINAL_STATES.has(runState.status) &&
      runState.spaceId &&
      runState.target.kind !== 'inline-agent'
    ) {
      // Kept out of the projection's own failure budget. This is a different
      // domain's work riding a convenient transaction boundary, and charging its
      // errors to the session's eviction count meant one tenant lagging the
      // migration that adds the marker column would evict every terminal run it
      // has inside five minutes — the durable row, the recovery cleanup and the
      // manifest removal along with the firing.
      //
      // Rethrown, not swallowed: leaving the candidate unacknowledged is what
      // re-drives the firing, and there is nothing else that would.
      try {
        await completionSchedules.recordForTerminalRun({
          tenantId,
          runId,
          spaceId: runState.spaceId,
          target: runState.target,
          status: runState.status,
          ...(runState.finalOutputRef !== undefined ? { outputRef: runState.finalOutputRef } : {}),
        });
      } catch (err) {
        throw new CompletionScheduleError(
          err instanceof Error ? err.message : String(err),
          err instanceof Error ? err : undefined,
        );
      }
    }

    if (runState.status === 'FAILED') {
      await assembleErrorReport({ redis, db, payloadStore, tenantId, runId, runState });
    }

    try {
      await routePauseNotifications({ db, payloadStore, tenantId, runState });
    } catch (err) {
      // Someone not being told must never block the pause becoming durable.
      logOrchestratorError(
        `[ProjectionWorker] pause notification routing failed for run ${runId}:`,
        err,
        { tenantId, runId },
      );
    }

    // Clean up recovery data for truly terminal runs
    if (TERMINAL_STATES.has(runState.status)) {
      await deleteRecoveryData(redis, tenantId, runId);
    }

    // Update manifest
    if (manifestService) {
      if (TERMINAL_STATES.has(runState.status)) {
        manifestService.removeTerminal(runId);
      } else {
        // PAUSED/STALLED: keep in manifest with updated status
        manifestService.updateStatus(runId, tenantId, runState.status);
      }
    }
  }

  // ── Status + event-tail projection (non-terminal runs) ──────────────────

  async function projectStatus(
    tenantId: string,
    runId: string,
    runState: SessionHotState,
  ): Promise<void> {
    const tenantContext = createTenantContext(tenantId as TenantId);

    const targetCols2 = targetToColumns(runState.target);
    let fenceWon = false;
    await withTenantSchema(db, tenantContext, async (tx) => {
      const upserted = await tx
        .insert(sessions)
        .values({
          sessionId: runId,
          targetKind: targetCols2.targetKind,
          targetSystemRole: targetCols2.targetSystemRole,
          targetAgentId: targetCols2.targetAgentId,
          targetInlineDefRef: targetCols2.targetInlineDefRef,
          agentVersion: runState.agentVersion,
          status: runState.status,
          startStepId: runState.currentStepId,
          currentStepExecutionId: runState.currentStepExecutionId,
          createdBy: runState.createdBy,
          traceId: runState.traceId,
          ...(runState.spaceId ? { spaceId: runState.spaceId } : {}),
          ...(runState.parentSessionId ? { parentSessionId: runState.parentSessionId } : {}),
          startedAt: toDateSafe(runState.startedAt, new Date(), 'session.startedAt'),
          lastActivityAt: projectedActivityAt(runState, new Date()),
          hotStateUpdatedAt: toDateSafe(
            runState.lastUpdatedAt,
            new Date(),
            'session.lastUpdatedAt',
          ),
        })
        .onConflictDoUpdate({
          target: sessions.sessionId,
          set: {
            status: runState.status,
            currentStepExecutionId: runState.currentStepExecutionId,
            lastActivityAt: projectedActivityAt(runState, new Date()),
            hotStateUpdatedAt: toDateSafe(
              runState.lastUpdatedAt,
              new Date(),
              'session.lastUpdatedAt',
            ),
            // Live again — the previous terminal transition's completion mark
            // must not swallow the next one's firing.
            completionSchedulesFiredAt: null,
          },
          // Same fence as the full flush: a stale projector must not regress a
          // terminal row to a live status it read before losing its lease.
          setWhere: sql`${sessions.hotStateUpdatedAt} IS NULL OR ${sessions.hotStateUpdatedAt} <= excluded.hot_state_updated_at`,
        })
        .returning({ sessionId: sessions.sessionId });
      fenceWon = upserted.length > 0;
    });

    if (!fenceWon) return;

    // A live-status upsert is how a resumed session's paused-step card
    // resolves — the pause path announces itself via fullFlush, the resume
    // path via this one.
    if (runState.spaceId) {
      publishActionCenterWake(redis, {
        source: 'session_status',
        tenantId,
        spaceId: runState.spaceId,
      });
    }

    // Events become durable while the run is still moving, not only when it
    // rests: a run that stays RUNNING past the stream cap would otherwise lose
    // its head before the first full flush ever ran. A separate transaction
    // from the status upsert, so a failing insert leaves the status row
    // current — the throw still withholds the acknowledgement, which is what
    // re-drives the events.
    await withTenantSchema(db, tenantContext, async (tx) => {
      await flushDurableEvents(tx, tenantId, runId);
    });

    // The candidate is acknowledged by the caller; a later mutation re-arms it.
    // Leaving it armed instead would re-upsert every running session every
    // cycle, forever, whether or not anything about it had changed.
  }

  // ── Failure record ──────────────────────────────────────────────────────

  /**
   * Count a failure and report whether the candidate may now be dropped.
   *
   * The answer is false whenever the record could not be written — which is
   * exactly the case when Postgres is what is failing. Evicting then would take
   * the whole backlog out on one outage, one log line each, with nothing left
   * pointing at any of them; leaving the candidates armed costs a retry.
   */
  async function recordFailure(
    tenantId: string,
    runId: string,
    reason: ProjectionFailureReason,
    message: string,
    evictAtAttempts: number,
  ): Promise<{ recorded: boolean; evicted: boolean; attempts: number }> {
    if (!sqlClient) return { recorded: false, evicted: false, attempts: 0 };
    try {
      const outcome = await recordProjectionFailure(sqlClient, {
        tenantId,
        sessionId: runId,
        reason,
        error: message,
        evictAtAttempts,
      });
      return { recorded: true, ...outcome };
    } catch (err) {
      logOrchestratorError(
        `[ProjectionWorker] Could not record the projection failure for run ${runId} — leaving it armed:`,
        err,
        { tenantId, runId, reason },
      );
      return { recorded: false, evicted: false, attempts: 0 };
    }
  }

  // ── Item protocol ───────────────────────────────────────────────────────

  /**
   * Work one claimed candidate and classify the outcome for the consumer.
   * Read before projecting; the consumer acknowledges this exact claim
   * afterwards — a mutation in between raises the version, the ack is
   * refused, and the session is due again with the newer state rather than
   * silently skipped.
   */
  async function projectOne(
    candidate: ProjectionCandidate,
    cycle: ProjectionCycleStats,
  ): Promise<LeasedWorkResult> {
    const { tenantId, runId } = candidate;
    try {
      const hotState = await getSessionStateSafe(redis, tenantId, runId);

      if (!hotState.ok) {
        // Nothing left to project from, so dropping is right — but a drop
        // with no record is the durable copy silently going stale forever.
        // A quarantined session is a platform bug an operator must see, and
        // a hot state that expired before its first flush has taken a
        // resumable paused run with it; neither is the same event.
        cycle.errorCount++;
        // The events outlive the hash — the stream has its own TTL — and
        // for a session whose state is gone they are the only record left.
        // Drained best-effort: a session that was never projected has no
        // sessions row for event_log's foreign key to attach to, so the
        // drain itself can be impossible. That failure must not divert to
        // the generic retry path — no retry makes it succeed, and the
        // record below, carrying the drain error, is the operator surface
        // for exactly this session.
        let drainError: string | null = null;
        try {
          const tenantContext = createTenantContext(tenantId as TenantId);
          await withTenantSchema(db, tenantContext, async (tx) => {
            await flushDurableEvents(tx, tenantId, runId);
          });
        } catch (err) {
          drainError = err instanceof Error ? err.message : String(err);
        }
        const reason: ProjectionFailureReason =
          hotState.kind === 'corrupt' ? 'state_corrupt' : 'state_missing';
        const baseMessage =
          hotState.kind === 'corrupt'
            ? 'Hot state is quarantined as corrupt; nothing to project from.'
            : 'Hot state is gone; the session was never fully projected.';
        return {
          kind: 'unworkable',
          disposition: async () => {
            const outcome = await recordFailure(
              tenantId,
              runId,
              reason,
              drainError === null
                ? baseMessage
                : `${baseMessage} Event drain failed: ${drainError}`,
              EVICT_IMMEDIATELY,
            );
            if (!outcome.evicted) {
              cycle.unrecordedFailureCount++;
              return false;
            }
            return true;
          },
        };
      }

      const runState = hotState.state;
      if (FLUSHABLE_STATES.has(runState.status)) {
        // Terminal/paused: full flush
        await fullFlush(tenantId, runId, runState);
        cycle.flushedCount++;
      } else {
        // Non-terminal (RUNNING, QUEUED): status upsert + event tail
        await projectStatus(tenantId, runId, runState);
        cycle.statusUpdatedCount++;
      }
      cycle.projectedCount++;
      return { kind: 'completed' };
    } catch (err) {
      cycle.errorCount++;
      if (err instanceof CompletionScheduleError) {
        // The durable row landed; only the firing did not. Leave the
        // candidate armed so the next cycle retries it, and spend none of
        // the session's eviction budget on a failure that is not its own.
        logOrchestratorError(
          `[ProjectionWorker] Completion schedules failed for run ${runId}; candidate stays armed`,
          err,
          { tenantId, runId },
        );
        return { kind: 'yield', reason: 'completion_schedules' };
      }
      const thrown = err;
      const message = err instanceof Error ? err.message : String(err);
      return {
        kind: 'failed',
        budget: async () => {
          const outcome = await recordFailure(
            tenantId,
            runId,
            'projection_error',
            message,
            MAX_PROJECTION_RETRIES,
          );
          if (outcome.evicted) {
            log.error(
              `[ProjectionWorker] Evicting run ${runId} after ${String(outcome.attempts)} failures — recorded in projection_failures`,
              undefined,
              { tenantId, runId, attempts: outcome.attempts },
            );
            return { evict: true };
          }
          if (!outcome.recorded) cycle.unrecordedFailureCount++;
          logOrchestratorError(
            `[ProjectionWorker] Error projecting run ${runId} (attempt ${String(outcome.attempts)}/${String(MAX_PROJECTION_RETRIES)}):`,
            thrown,
            { tenantId, runId },
          );
          return { evict: false };
        },
      };
    }
  }

  /**
   * One consumer per cycle: `projectOne` folds its outcomes into that cycle's
   * stats, and the protocol-level counts are merged in after the batch.
   */
  function buildCycleConsumer(cycle: ProjectionCycleStats) {
    return createLeasedWorkConsumer<ProjectionCandidate>({
      name: 'projection',
      claim: (limit) => claimProjectionCandidates(redis, limit),
      // A member that is not a pair of uuids cannot name a session and cannot
      // be recorded either — the failure table is keyed by uuid, so the record
      // that would authorise an eviction is itself rejected. Staying armed is
      // right for a Postgres outage and wrong here: nothing about this entry
      // will ever become valid, so it would be retried, and logged, forever.
      validate: ({ tenantId, runId }) =>
        isUuid(tenantId) && isUuid(runId)
          ? { ok: true }
          : { ok: false, reason: 'member does not name a session' },
      discard: ({ tenantId, runId }) => dropProjectionCandidate(redis, tenantId, runId),
      work: (candidate) => projectOne(candidate, cycle),
      ack: ({ tenantId, runId, version, leaseUntilMs }) =>
        ackProjection(redis, tenantId, runId, version, leaseUntilMs),
      // Guarded on the claimed version: the recording round trip is wide
      // enough for a resume to rehydrate the session and re-arm.
      retire: ({ tenantId, runId, version, leaseUntilMs }) =>
        dropProjectionCandidateIfVersion(redis, tenantId, runId, version, leaseUntilMs),
      afterCompleted: async ({ tenantId, runId }) => {
        if (!sqlClient) return;
        // Unconditional, and deliberately so: the record may have been
        // written by another instance, and this row is the operator's view of
        // what is failing — a session that recovered must leave it. The cost
        // is one indexed single-row DELETE per projection, a no-op almost
        // always; scoping it to locally-observed failures was tried and makes
        // a peer's record immortal.
        try {
          await clearProjectionFailure(sqlClient, tenantId, runId);
        } catch {
          // A stale record over-reports; it never loses anything.
        }
      },
      onEvent: (event) => {
        switch (event.kind) {
          case 'discarded':
            log.warn('Dropping a projection candidate that does not name a session', {
              tenantId: event.claim.tenantId,
              runId: event.claim.runId,
            });
            break;
          case 'ack_error':
            logOrchestratorError(
              `[ProjectionWorker] Projected run ${event.claim.runId} but could not acknowledge it:`,
              event.error,
              { tenantId: event.claim.tenantId, runId: event.claim.runId },
            );
            break;
          case 'work_error':
            cycle.errorCount++;
            logOrchestratorError(
              `[ProjectionWorker] Error projecting run ${event.claim.runId}:`,
              event.error,
              { tenantId: event.claim.tenantId, runId: event.claim.runId },
            );
            break;
          case 'discard_error':
            cycle.errorCount++;
            logOrchestratorError(
              `[ProjectionWorker] Could not drop the unnameable candidate ${event.claim.runId}; it stays armed:`,
              event.error,
              { tenantId: event.claim.tenantId, runId: event.claim.runId },
            );
            break;
          case 'retire_error':
            cycle.errorCount++;
            logOrchestratorError(
              `[ProjectionWorker] Recorded the failure for run ${event.claim.runId} but could not retire its candidate:`,
              event.error,
              { tenantId: event.claim.tenantId, runId: event.claim.runId },
            );
            break;
          case 'ack_refused':
          case 'retire_refused':
          case 'disposition_failed':
          case 'budget_error':
          case 'after_completed_error':
          case 'release_error':
            break;
        }
      },
    });
  }

  // ── Main cycle ──────────────────────────────────────────────────────────

  let cycleInFlight = false;

  async function processCycle(): Promise<void> {
    // The interval fires whether or not the previous cycle finished, and a
    // cycle can legitimately outlast it — one slow tenant transaction is
    // enough. Overlapping cycles claim on 30s leases that expire under them
    // and end up projecting the same session concurrently.
    if (cycleInFlight) return;
    cycleInFlight = true;
    try {
      await runCycle();
    } finally {
      cycleInFlight = false;
    }
  }

  async function runCycle(): Promise<void> {
    const cycleStart = Date.now();
    const cycle = emptyStats();

    try {
      const batch = await buildCycleConsumer(cycle).runBatch(batchSize);
      cycle.candidateCount = batch.claimed;
      // Both removals leave a trace behind them: the log line for a member
      // that could not name a session, the durable failure record for the
      // rest.
      cycle.evictedCount = batch.discarded + batch.retired;
      cycle.ackRefusedCount = batch.ackRefused;
    } catch (err) {
      cycle.errorCount++;
      logOrchestratorError('[ProjectionWorker] Error in projection cycle:', err, {});
    }

    cycle.cycleMs = Date.now() - cycleStart;
    stats = cycle;

    // Record projection cycle lag for OTEL metrics
    recordProjectionLag(stats.cycleMs, {});

    if (cycle.errorCount > 0) {
      log.error('Projection cycle completed with errors', undefined, {
        ...stats,
      });
    } else if (stats.cycleMs > 2000) {
      log.warn('Projection cycle slow', { ...stats });
    } else if (cycle.projectedCount > 0) {
      log.debug(
        `Projected ${String(cycle.projectedCount)} runs (${String(cycle.flushedCount)} flushed, ${String(cycle.statusUpdatedCount)} status-only) in ${String(stats.cycleMs)}ms`,
      );
    }
  }

  return {
    start() {
      if (running) throw new Error('ProjectionWorker is already running');

      running = true;
      stopRequested = false;

      log.info(`Starting (interval: ${String(intervalMs)}ms, batch: ${String(batchSize)})`);

      void processCycle();
      intervalHandle = setInterval(() => {
        if (!stopRequested) void processCycle();
      }, intervalMs);
    },

    stop(): Promise<void> {
      if (!running) return Promise.resolve();

      stopRequested = true;
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }

      running = false;
      log.info('Stopped');
      return Promise.resolve();
    },

    async runOnce() {
      await processCycle();
      return { ...stats };
    },

    isRunning() {
      return running;
    },

    lastCycleStats() {
      return { ...stats };
    },
  };
}
