import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import type { ApiSessionEvent, TenantId, SessionId } from '@aflow/schemas';
import { getSessionStateSafe, type SessionHotState } from '@aflow/redis';
import type { RunViewState } from '@aflow/run-view';
import { deriveSessionBlockedOn } from './deriveSessionBlockedOn.js';
import { foldEventsToSnapshot } from './foldSessionEvents.js';
import { readSimulatedBindings } from './readSimulatedBindings.js';
import { createSessionTailService } from './sessionTail.js';
import { buildSessionCatchupEvents } from './workflowRunCatchup.js';

/**
 * How many events the mount folds.
 *
 * The unit is events rather than messages because one read has to answer the
 * page, the live-resume position and the page-back position together, and only
 * the reader's own unit does that in a single traversal.
 *
 * Measured across the ten densest conversations in a real log: 200 events folds
 * to 30–60 messages — the window a reader opens into — and holds the response
 * under 250 KB on every one of them, including a media-heavy session that
 * reaches 1 MB by 800 events.
 */
export const SNAPSHOT_PAGE_EVENTS = 200;

/**
 * The deepest page a reader can ask for by scrolling back.
 *
 * Reading further into a conversation re-folds it from one end rather than
 * stitching a new page onto the last one, so the cost of a page is the depth
 * asked for. Without a ceiling, scrolling back through a long session walks
 * straight back into the whole-history fold this replaced — one click at a
 * time, but the same read.
 *
 * Ten pages. On the densest conversation in the local log that is roughly 600
 * messages and 1 MB, which is past what anyone scrolls to and still bounded.
 * `hasOlder` stays true beyond it, so the end of the ceiling is not dressed up
 * as the beginning of the conversation.
 */
export const SNAPSHOT_MAX_PAGE_EVENTS = SNAPSHOT_PAGE_EVENTS * 10;

export interface SessionSnapshot {
  snapshot: RunViewState;
  /**
   * Opaque position of the newest event folded, for resuming the live tail —
   * `?after=` on the SSE stream, or the realtime subscribe cursor. `null` when
   * the session has no events yet.
   *
   * Not an event id. The reader seeks Redis by stream id and Postgres by
   * sequence, and refuses a cursor it cannot position from.
   */
  tailCursor: string | null;
  /**
   * Position to ask the next page back from, `null` when nothing is older.
   *
   * It and `tailCursor` come out of the same traversal, so the page, the live
   * tail and the history behind it are all measured from one watermark — an
   * event committed mid-mount cannot fall between two of them.
   */
  olderCursor: string | null;
  /** Whether history exists before the first event in the page. */
  hasOlder: boolean;
  /** Number of durable events folded — the page, not the session. */
  foldedEventCount: number;
  /** Number of synthetic workflow-run catch-up events folded. */
  catchupEventCount: number;
  /** Session status from hot state. `null` when the session has been flushed and Redis evicted its state. */
  status: string | null;
  catchupFailed: boolean;
}

export interface BuildSessionSnapshotDeps {
  db: PostgresJsDatabase;
  redis: Redis | null;
  payloadStore: PayloadStore;
}

export interface BuildSessionSnapshotOptions {
  /**
   * Events folded, clamped to `SNAPSHOT_MAX_PAGE_EVENTS`. Default
   * `SNAPSHOT_PAGE_EVENTS`.
   */
  limit?: number;
}

/**
 * The page actually read, for a depth a caller asked for.
 *
 * Clamped rather than rejected: a reader scrolling back is asking for more
 * conversation, and the honest answer to "more than there is room for" is the
 * deepest page there is room for with `hasOlder` still true — not an error, and
 * not silently the default page either.
 */
export function clampSnapshotLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return SNAPSHOT_PAGE_EVENTS;
  const floored = Math.floor(requested);
  if (floored < 1) return SNAPSHOT_PAGE_EVENTS;
  return Math.min(floored, SNAPSHOT_MAX_PAGE_EVENTS);
}

export function overlayBlockedOnFromHotState(
  snapshot: RunViewState,
  hotState: Pick<
    SessionHotState,
    | 'status'
    | 'waitingOnWorkflowRunId'
    | 'delegationPauseSource'
    | 'waitingForChildSessionIds'
    | 'currentStepExecutionId'
    | 'pauseReason'
  > | null,
): RunViewState {
  if (!hotState) return snapshot;
  if (hotState.status !== snapshot.status) return snapshot;
  // Mirror the detail builder (sessions.ts getSessionById): the paused
  // step's id comes from hot state when a pause is recorded there, else
  // from the folded requiredInput.
  const requiredInputStepExecutionId =
    hotState.currentStepExecutionId && hotState.pauseReason
      ? hotState.currentStepExecutionId
      : snapshot.requiredInput?.stepExecutionId || undefined;
  const derived = deriveSessionBlockedOn(hotState, requiredInputStepExecutionId);
  // A needs_oauth_consent pause folds a richer blockedOn (carrying the consent
  // target) from the SessionPaused event metadata; hot-state derivation can only
  // see a generic user_input, so don't downgrade it on cold mount — that would let
  // the chat resume-gate treat a consent pause as type-to-resume.
  if (derived?.kind === 'user_input' && snapshot.blockedOn?.kind === 'needs_oauth_consent') {
    return snapshot;
  }
  return { ...snapshot, blockedOn: derived };
}

/**
 * Put back the rehearsed bindings the page could not have seen.
 *
 * The fold only ever knows about the events in front of it, and this list does
 * not decay: one fabricated fact makes the whole room a rehearsal and keeps it
 * one. A session that rehearsed early and not since would drop its own banner
 * as its history grew past the page — the invariant inverted, silently.
 *
 * Durable first, because those are the older ones; the fold contributes only
 * what has not reached the durable log yet.
 */
export function withDurableSimulatedBindings(
  snapshot: RunViewState,
  durable: string[],
): RunViewState {
  if (durable.length === 0) return snapshot;
  const merged = [...durable];
  for (const id of snapshot.simulatedBindings) {
    if (!merged.includes(id)) merged.push(id);
  }
  return { ...snapshot, simulatedBindings: merged };
}

export async function buildSessionSnapshot(
  deps: BuildSessionSnapshotDeps,
  tenantId: TenantId,
  sessionId: SessionId,
  spaceId: string,
  opts: BuildSessionSnapshotOptions = {},
): Promise<SessionSnapshot> {
  const limit = clampSnapshotLimit(opts.limit);

  // 1. Hot state — for the `status` field. May be missing after flush eviction.
  const hotStateResult = deps.redis
    ? await getSessionStateSafe(deps.redis, tenantId, sessionId)
    : null;
  const hotState = hotStateResult?.ok ? hotStateResult.state : null;

  // 2. The newest page, and the two positions measured against it.
  const tailService = createSessionTailService({
    db: deps.db,
    redis: deps.redis,
    pubsubSubscriber: null, // not used by `tailBefore`
  });
  const page = await tailService.tailBefore(tenantId, sessionId, undefined, { limit });
  if ('kind' in page) {
    // Only a cursor can be un-seekable, and this read supplies none. Reaching
    // here means `tailBefore` changed shape rather than that this session is
    // unreadable, so it is raised rather than served as an empty conversation.
    throw new Error(
      `Positionless snapshot read asked to reconcile (${page.reason}); a read with no cursor has nothing to reconcile against.`,
    );
  }

  // 3. Facts older than the page that the page is not allowed to lose.
  const durableSimulatedBindings = await readSimulatedBindings(deps.db, tenantId, sessionId);

  // 4. Catch-up events for workflow-run surfaces the session is waiting on.
  // These are synthetic — fresh eventIds that aren't in any durable stream.
  // Folded after the page so SSE resume still points at a real, seekable event.
  //
  // Best-effort: a catch-up failure (e.g. a missing payload ref in one of
  // the waited-on runs) must not blank the durable chat history. Log and
  // proceed with a durable-only fold; the live SSE stream will still emit
  // surface updates as the workflow runs progress. Mirrors the SSE
  // handler's wrap at `events.ts:519`.
  let catchupEvents: ApiSessionEvent[] = [];
  let catchupFailed = false;
  try {
    const catchup = await buildSessionCatchupEvents(
      deps.db,
      deps.payloadStore,
      tenantId,
      sessionId,
      spaceId,
      deps.redis,
    );
    catchupEvents = catchup.events;
  } catch (err) {
    console.warn('[buildSessionSnapshot] catch-up failed; returning durable-only snapshot', err);
    catchupFailed = true;
  }

  const folded = foldEventsToSnapshot(page.events, catchupEvents);
  const withSimulated = withDurableSimulatedBindings(folded.snapshot, durableSimulatedBindings);

  return {
    snapshot: overlayBlockedOnFromHotState(withSimulated, hotState),
    tailCursor: page.nextCursor === '' ? null : page.nextCursor,
    olderCursor: page.olderCursor ?? null,
    hasOlder: page.hasOlder,
    foldedEventCount: page.events.length,
    catchupEventCount: folded.catchupEventCount,
    status: hotState?.status ?? null,
    catchupFailed,
  };
}
