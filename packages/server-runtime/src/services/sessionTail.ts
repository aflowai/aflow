import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { ApiSessionEvent, ReconcileReason, SessionId, TenantId } from '@aflow/schemas';
import { createTenantContext, withTenantSchema, eventLog, sessions } from '@aflow/database';
import {
  compareRedisStreamIds,
  readSessionEventEntriesBefore,
  readSessionEventEntries,
} from '@aflow/redis';
import type { SessionEventEntry } from '@aflow/redis';
import type { EventLogRow } from '@aflow/database';
import { projectPostgresEventToApi, projectRedisEventToApi } from './eventProjection.js';
import type { PubSubSubscriber } from './pubsub.js';
import { subscribeSessionWakeup } from './sessionWakeup.js';
import { createLiveDeltaReader, type LiveDeltaFrame } from './sessionLiveDeltas.js';
import { decodeSessionCursor, encodeSessionCursor } from './sessionCursor.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Default `limit` for `tailAfter` when the caller doesn't specify one.
 * Matches the legacy `getSessionEvents` default.
 */
const DEFAULT_TAIL_LIMIT = 100;

// ============================================================================
// Types
// ============================================================================

export interface SessionTailDeps {
  db: PostgresJsDatabase;
  redis: Redis | null;
  /**
   * Pub/Sub source for wakeups. `live` has no other trigger — there is no
   * safety poll behind it — so with `null` it drains once and then waits for
   * its abort signal. Only reachable when Redis itself is absent, where the
   * feature is inert anyway.
   */
  pubsubSubscriber: PubSubSubscriber | null;
}

export type TailAfterResult =
  | {
      kind: 'events';
      events: ApiSessionEvent[];
      /**
       * The resume position for each event in `events`, same order and length.
       *
       * A page-end cursor alone is not enough for a live subscriber: a client
       * that disconnects part-way through a page would resume from a position
       * covering events it never received. Each event carries its own.
       */
      eventCursors: string[];
      /**
       * Cursor of the last event returned, OR the caller's input
       * cursor when no new events were available. Never `null` when
       * `kind === 'events'`.
       */
      nextCursor: string;
      /**
       * True when more events exist past `nextCursor`. The caller may
       * loop with the new cursor to drain.
       */
      hasMore: boolean;
    }
  | {
      kind: 'reconcile_required';
      reason: ReconcileReason;
      /** Best-effort last-known-good cursor before the gap, when known. */
      cursor?: string;
    };

export interface TailAfterOptions {
  /** Default 100; caller-side cap on returned events. */
  limit?: number;
}

export interface LiveTailOptions {
  /** Required — the position to resume from. Use `tailCursor` from the session
   *  snapshot, or the position a `tailBefore` page reports. */
  cursor: string;
  /** Stop iterating when this signal fires. */
  signal: AbortSignal;
  /** Bound per-wakeup work. Default 200. */
  perWakeupLimit?: number;
  /**
   * Events the caller already delivered before this tail started — the mount
   * page, and the catch-up burst behind it. The live reader observes them, so a
   * step that was already running when the reader arrived is one it knows to
   * read; without them a mid-run joiner waits for the next durable event before
   * anything it missed can reach it.
   */
  seedEvents?: readonly ApiSessionEvent[];
}

/**
 * One item on the live subscription. Durable events and live frames share the
 * subscription and the loop so they share one ordering decision: within a
 * wakeup the loop drains durable events before reading the live buffer, so a
 * step's terminal `event` is always emitted before — never after — any
 * `live_delta` for that step. The two are distinguished by `kind`, not by
 * transport.
 */
export type LiveTailItem =
  | { kind: 'event'; event: ApiSessionEvent; cursor: string }
  | { kind: 'live_delta'; frame: LiveDeltaFrame };

export interface SessionTailService {
  tailAfter(
    tenantId: TenantId,
    sessionId: SessionId,
    cursor: string | undefined,
    opts?: TailAfterOptions,
  ): Promise<TailAfterResult>;

  /**
   * The newest page of a session, for a reader opening it fresh.
   *
   * `tailAfter` with no cursor answers from the START of the history, which for
   * a session longer than one page is the wrong end: the page and the live tail
   * end up at opposite ends with a gap between them.
   */
  tailBefore(
    tenantId: TenantId,
    sessionId: SessionId,
    beforeCursor: string | undefined,
    opts?: TailAfterOptions,
  ): Promise<
    LatestResult | { kind: 'reconcile_required'; reason: ReconcileReason; cursor?: string }
  >;

  live(
    tenantId: TenantId,
    sessionId: SessionId,
    opts: LiveTailOptions,
  ): AsyncIterable<LiveTailItem>;
}

// ============================================================================
// Implementation
// ============================================================================

// ============================================================================
// Pure decision core — testable without Redis/DB
// ============================================================================

export interface TailAfterPort {
  /**
   * Redis entries strictly after `fromStreamId`, plus the oldest id the stream
   * still retains.
   *
   * `oldestId` is what makes eviction answerable without scanning: a cursor
   * older than it has had entries trimmed out from under it, and reading
   * forward from it would silently skip them.
   */
  readRedisFrom: (
    fromStreamId: string,
    limit: number,
  ) => Promise<{
    entries: SessionEventEntry[];
    scanned: number;
    /** Stream id of the last entry inspected, parsed or not. */
    lastId: string;
    oldestId: string | null;
  }>;
  /**
   * Convert an `eventId` cursor to its Postgres `sequenceNumber`, or
   * `null` when not in Postgres. `null` means "cursor never made it
   * to durable storage" — the caller distinguishes that from a Redis
   * miss to decide reconcile vs. replay.
   */
  seekPostgresSequence: (eventId: string) => Promise<number | null>;
  /**
   * Page Postgres past `afterSeq` (or from the start when `null`).
   * Returns up to `limit` rows in seq order. The driver passes `limit
   * + 1` when it wants to observe `hasMore` without re-reading.
   */
  readPostgresPage: (afterSeq: number | null, limit: number) => Promise<EventLogRow[]>;
  /**
   * The stream id Postgres is durable through, or `null` when nothing has been
   * flushed yet.
   *
   * **Read before the Postgres page, never after.** The projection worker
   * advances this in the same transaction as the rows it flushes, so a
   * watermark read afterwards can name a position past the page just taken —
   * and a Redis read starting there would skip the interval between them.
   * Taken first, it can only be behind, and behind merely overlaps.
   */
  readFlushWatermark: () => Promise<string | null>;
  /**
   * The newest `limit` Redis entries, chronological, plus whether the stream
   * holds older ones.
   *
   * The mirror of `readRedisFrom`: that one answers "what followed this
   * position", this one answers "what is the end of the history" — which is the
   * question a fresh mount is actually asking.
   */
  readRedisBefore: (
    beforeStreamId: string | null,
    limit: number,
  ) => Promise<{ entries: SessionEventEntry[]; hasOlder: boolean; oldestId: string | null }>;
  /** The `limit` durable rows ending before `beforeSeq`, or the newest when `null`. */
  readPostgresBefore: (beforeSeq: number | null, limit: number) => Promise<EventLogRow[]>;
}

/** A cursor that points at a Redis entry still inside the retained window. */
function redisPositionUsable(
  redisStreamId: string | undefined,
  oldestId: string | null,
): redisStreamId is string {
  if (redisStreamId === undefined) return false;
  // Nothing retained: the stream is empty or expired, so it can confirm nothing.
  if (oldestId === null) return false;
  // Trimmed past the cursor — entries between it and `oldestId` are gone.
  return compareRedisStreamIds(redisStreamId, oldestId) >= 0;
}

function cursorFromEntry(entry: SessionEventEntry): string {
  return encodeSessionCursor({ eventId: entry.event.eventId, redisStreamId: entry.id });
}

function cursorFromPostgresRow(row: EventLogRow): string {
  return encodeSessionCursor({
    eventId: row.eventId,
    postgresSequence: row.sequenceNumber,
  });
}

/**
 * Events after `rawCursor`, and where to resume from next.
 *
 * Two paths. When the cursor names a Redis entry still inside the retained
 * window, the answer comes from one seek — this is the live tail's steady
 * state, and it costs whatever followed the cursor rather than the whole
 * conversation. Otherwise the durable log answers, and the Redis-only tail past
 * the flush watermark is appended to it.
 */
/** What a backward read answers with. */
export interface LatestResult {
  events: ApiSessionEvent[];
  /** Per-event reader positions, parallel to `events`. */
  eventCursors: string[];
  /** Where live tailing resumes — the position of the newest event returned. */
  nextCursor: string;
  /** The position to ask for the next page back, absent when none exists. */
  olderCursor?: string;
  /** Whether history exists before the first event returned. */
  hasOlder: boolean;
}

/**
 * The page of events ending at `before`, or the newest page when it is `null`.
 *
 * A reader asking for a page "from the beginning" of a long session receives
 * the beginning, then tails live, and everything between the two is
 * unreachable — the page and the live tail are at opposite ends. Anchoring to
 * the newest event closes that by construction, and walking back from a
 * returned position is what makes the rest reachable without ever asking for
 * the whole history at once.
 *
 * Redis answers alone whenever it still holds a full page, which is the case
 * for any session recent enough to be open. The durable log fills the rest, and
 * is deduped by event id because the flush window leaves the same event in both
 * for a time.
 */
export async function beforeFrom(
  port: TailAfterPort,
  before: { eventId?: string; redisStreamId?: string; postgresSequence?: number } | null,
  limit: number,
): Promise<LatestResult> {
  // Three cases, and collapsing the last two is what delivers a page twice.
  // No position at all means "from the end", so Redis answers with its newest.
  // A position naming a stream id is inside the hot window, so Redis walks back
  // from it. A position naming ONLY a durable sequence is already past that
  // window — every hot entry is newer than it, so Redis has nothing to add, and
  // asking it "from the end" would return the very events the caller has.
  const hot =
    before === null
      ? await port.readRedisBefore(null, limit)
      : before.redisStreamId !== undefined
        ? await port.readRedisBefore(before.redisStreamId, limit)
        : { entries: [], hasOlder: false, oldestId: null };

  const events: ApiSessionEvent[] = [];
  const eventCursors: string[] = [];
  const seen = new Set<string>();

  // Older-from-durable first, so the result stays chronological.
  let durableHasOlder = false;
  if (hot.entries.length < limit) {
    const need = limit - hot.entries.length;
    // Older than the HOT WINDOW, not older than the caller's cursor.
    //
    // The durable log holds the hot entries too, for as long as it takes the
    // flush to catch up, so "the newest durable rows" and "the hot entries"
    // are largely the same events. Reading the newest ones to fill a short hot
    // page puts the newest events at the FRONT — dedupe then drops their hot
    // copies, and the page renders the end of the conversation followed by its
    // middle. Measured on a 680-event session: 120 events from 08:08 ahead of
    // 560 from 05:13.
    //
    // Reachable whenever the hot stream holds fewer entries than a page and
    // more than none — which retention trimming makes ordinary — so the anchor
    // is the oldest hot entry, and the durable read starts strictly before it.
    let durableBefore = before?.postgresSequence ?? null;
    // Which event the durable read has to start before.
    //
    // Normally the oldest hot entry: the page continues below the hot window.
    // But a Redis-origin cursor carries no durable sequence, and when it names
    // the oldest entry the stream still retains, the exclusive hot read comes
    // back empty — leaving nothing to anchor on and the newest durable rows to
    // fall out, which is the page the caller was just shown. The cursor's own
    // event is the floor in that case; it is the boundary being crossed.
    const floorEventId =
      hot.entries[0]?.event.eventId ?? (durableBefore === null ? before?.eventId : undefined);
    if (floorEventId !== undefined) {
      const durableFloor = await port.seekPostgresSequence(floorEventId);
      // `null` means that event never reached Postgres, so every durable row
      // really is older than it and the newest of them are the right ones.
      if (durableFloor !== null) durableBefore = durableFloor;
    }
    // One more than needed, so "older exists" is answered by this read rather
    // than by a second one — the same trick the forward page uses.
    const fetched = await port.readPostgresBefore(durableBefore, need + 1);
    durableHasOlder = fetched.length > need;
    const rows = durableHasOlder ? fetched.slice(fetched.length - need) : fetched;
    for (const row of rows) {
      const projected = projectPostgresEventToApi(row);
      // Dedupe on the PROJECTED id, as the forward path does — the row's own
      // id and the projected one are not guaranteed to agree.
      if (seen.has(projected.eventId)) continue;
      events.push(projected);
      eventCursors.push(cursorFromPostgresRow(row));
      seen.add(projected.eventId);
    }
  }

  for (const entry of hot.entries) {
    if (seen.has(entry.event.eventId)) continue;
    events.push(projectRedisEventToApi(entry.event));
    eventCursors.push(cursorFromEntry(entry));
    seen.add(entry.event.eventId);
  }

  // Trim from the OLD end: the newest events are the ones that must survive,
  // and the tail position has to name the last event actually returned or the
  // live tail would resume past events the caller never got.
  const overflow = events.length - limit;
  if (overflow > 0) {
    events.splice(0, overflow);
    eventCursors.splice(0, overflow);
  }

  const hasOlder = hot.hasOlder || durableHasOlder || overflow > 0;
  const olderCursor = eventCursors[0];

  return {
    events,
    eventCursors,
    nextCursor: eventCursors[eventCursors.length - 1] ?? '',
    // Only offered when there is something behind it; a position with nothing
    // older invites a page that comes back empty forever.
    ...(hasOlder && olderCursor !== undefined ? { olderCursor } : {}),
    hasOlder,
  };
}

export async function tailAfterFrom(
  port: TailAfterPort,
  rawCursor: string | undefined,
  limit: number,
): Promise<TailAfterResult> {
  if (rawCursor !== undefined && rawCursor.length > 0) {
    const cursor = decodeSessionCursor(rawCursor);
    if (cursor === null) {
      // Nothing to seek to. Saying so is the whole reason the cursor is
      // validated before any datastore call.
      return { kind: 'reconcile_required', reason: 'cursor_malformed' };
    }

    // ── Fast path: seek Redis ────────────────────────────────────────────
    if (cursor.redisStreamId !== undefined) {
      const { entries, scanned, lastId, oldestId } = await port.readRedisFrom(
        cursor.redisStreamId,
        limit + 1,
      );
      if (redisPositionUsable(cursor.redisStreamId, oldestId)) {
        // `scanned`, not `entries.length`: an entry this revision could not
        // parse still occupies the window, and counting only the survivors
        // would report "nothing follows" while events sat past the page.
        const hasMore = scanned > limit;
        const page = hasMore ? entries.slice(0, limit) : entries;
        const last = page[page.length - 1];
        // A page can scan entries and parse none of them — a run of event types
        // this revision does not know. Holding the cursor there while reporting
        // more to come is a drain that re-reads the same range forever, so the
        // position steps over what was scanned even though it names no event.
        const nextCursor = last
          ? cursorFromEntry(last)
          : scanned > 0
            ? encodeSessionCursor({ redisStreamId: lastId })
            : rawCursor;
        return {
          kind: 'events',
          events: page.map((e) => projectRedisEventToApi(e.event)),
          eventCursors: page.map((e) => cursorFromEntry(e)),
          nextCursor,
          hasMore,
        };
      }
      // Trimmed past. Fall through to the durable log.
    }

    // ── Durable path ─────────────────────────────────────────────────────
    const seq =
      cursor.postgresSequence ??
      (cursor.eventId !== undefined ? await port.seekPostgresSequence(cursor.eventId) : null);
    if (seq === null) {
      // Gone from Redis and never durable: the interval cannot be reconstructed.
      return { kind: 'reconcile_required', reason: 'cursor_evicted', cursor: rawCursor };
    }
    return durablePageWithRedisTail(port, seq, limit, rawCursor);
  }

  // ── No cursor: the first page ──────────────────────────────────────────
  return durablePageWithRedisTail(port, null, limit, undefined);
}

/**
 * A Postgres page, extended with whatever Redis holds past the flush watermark.
 *
 * The watermark is read **first**. The projection worker advances it in the
 * same transaction as the rows it writes, so a watermark taken after the page
 * could already name a position beyond it — and the Redis read would start past
 * events the page never covered. Taken first it can only lag, which costs an
 * overlap that `seen` removes.
 */
async function durablePageWithRedisTail(
  port: TailAfterPort,
  afterSeq: number | null,
  limit: number,
  fallbackCursor: string | undefined,
): Promise<TailAfterResult> {
  const watermark = await port.readFlushWatermark();
  const rows = await port.readPostgresPage(afterSeq, limit + 1);

  let hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const events: ApiSessionEvent[] = [];
  const eventCursors: string[] = [];
  const seen = new Set<string>();
  let nextCursor = fallbackCursor;

  for (const row of pageRows) {
    const projected = projectPostgresEventToApi(row);
    events.push(projected);
    eventCursors.push(cursorFromPostgresRow(row));
    seen.add(projected.eventId);
    nextCursor = cursorFromPostgresRow(row);
  }

  // Only reach for Redis once the durable page is exhausted; while `hasMore`
  // is set the caller will come back for the next durable page anyway.
  if (!hasMore) {
    const { entries, scanned, lastId } = await port.readRedisFrom(watermark ?? '0', limit + 1);
    if (scanned > limit) hasMore = true;
    // The same trap the seek path has: a page can scan entries and parse none
    // of them, and reporting more to come from a position that never moved is a
    // drain re-reading the same page forever. Take the scanned position even
    // though it names no event.
    if (scanned > 0 && entries.length === 0) {
      nextCursor = encodeSessionCursor({ redisStreamId: lastId });
    }
    for (const entry of entries) {
      if (seen.has(entry.event.eventId)) continue;
      if (events.length >= limit) {
        hasMore = true;
        break;
      }
      events.push(projectRedisEventToApi(entry.event));
      eventCursors.push(cursorFromEntry(entry));
      seen.add(entry.event.eventId);
      nextCursor = cursorFromEntry(entry);
    }
  }

  if (nextCursor === undefined) {
    // No cursor in, nothing out: an empty session. There is no position to
    // name yet, and the caller re-asks with no cursor.
    return { kind: 'events', events: [], eventCursors: [], nextCursor: '', hasMore: false };
  }

  return { kind: 'events', events, eventCursors, nextCursor, hasMore };
}

/**
 * The stream id Postgres is durable through for this session.
 *
 * Written by the projection worker in the same transaction as the rows it
 * flushes, so it never names a position the durable log has not reached.
 */
async function readFlushWatermark(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  sessionId: SessionId,
): Promise<string | null> {
  const tenantContext = createTenantContext(tenantId);
  const { eq } = await import('drizzle-orm');
  const rows = await withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({ cursor: sessions.lastFlushedEventStreamId })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1),
  );
  return rows[0]?.cursor ?? null;
}

/**
 * Seek Postgres for an event by `eventId`, returning its `sequenceNumber`.
 * Used to convert the opaque eventId cursor into a Postgres-ordered
 * cursor for resume.
 */
async function seekEventSequence(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  sessionId: SessionId,
  eventId: string,
): Promise<number | null> {
  const tenantContext = createTenantContext(tenantId);
  const { eq, and } = await import('drizzle-orm');
  const rows = await withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({ sequenceNumber: eventLog.sequenceNumber })
      .from(eventLog)
      .where(and(eq(eventLog.sessionId, sessionId), eq(eventLog.eventId, eventId)))
      .limit(1),
  );
  return rows[0]?.sequenceNumber ?? null;
}

/**
 * Read up to `limit` Postgres rows past `afterSeq`. Used both for
 * initial snapshot and for `tailAfter` fallback when the cursor is in
 * Postgres but not in Redis.
 */
async function readPostgresPage(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  sessionId: SessionId,
  afterSeq: number | null,
  limit: number,
): Promise<EventLogRow[]> {
  const tenantContext = createTenantContext(tenantId);
  const { eq, and, gt } = await import('drizzle-orm');
  return withTenantSchema(db, tenantContext, async (tx) => {
    const conditions = [eq(eventLog.sessionId, sessionId)];
    if (afterSeq !== null) {
      conditions.push(gt(eventLog.sequenceNumber, afterSeq));
    }
    return tx
      .select()
      .from(eventLog)
      .where(and(...conditions))
      .orderBy(eventLog.sequenceNumber)
      .limit(limit);
  });
}

/**
 * The `limit` durable rows ending before `beforeSeq`, or the newest when it is
 * `null`, returned chronologically.
 *
 * Ordered descending in SQL so the database can stop at `limit` instead of
 * sorting the whole session, then reversed here — every reader in this file
 * hands events to a reducer that folds them in order.
 */
async function readPostgresBefore(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  sessionId: SessionId,
  beforeSeq: number | null,
  limit: number,
): Promise<EventLogRow[]> {
  const tenantContext = createTenantContext(tenantId);
  const { eq, and, lt, desc } = await import('drizzle-orm');
  return withTenantSchema(db, tenantContext, async (tx) => {
    const conditions = [eq(eventLog.sessionId, sessionId)];
    if (beforeSeq !== null) {
      // Exclusive, so a page boundary does not repeat the row the caller
      // paged back from.
      conditions.push(lt(eventLog.sequenceNumber, beforeSeq));
    }
    const rows = await tx
      .select()
      .from(eventLog)
      .where(and(...conditions))
      .orderBy(desc(eventLog.sequenceNumber))
      .limit(limit);
    return rows.reverse();
  });
}

export function createSessionTailService(deps: SessionTailDeps): SessionTailService {
  const { db, redis, pubsubSubscriber } = deps;

  async function tailAfter(
    tenantId: TenantId,
    sessionId: SessionId,
    cursor: string | undefined,
    opts: TailAfterOptions = {},
  ): Promise<TailAfterResult> {
    const limit = opts.limit ?? DEFAULT_TAIL_LIMIT;
    const port: TailAfterPort = {
      readRedisFrom: async (fromStreamId, lim) => {
        if (!redis) return { entries: [], scanned: 0, lastId: fromStreamId, oldestId: null };
        const { entries, scanned, lastId, oldestId } = await readSessionEventEntries(
          redis,
          tenantId,
          sessionId,
          fromStreamId,
          lim,
        );
        return { entries, scanned, lastId, oldestId };
      },
      seekPostgresSequence: (eventId) => seekEventSequence(db, tenantId, sessionId, eventId),
      readPostgresPage: (afterSeq, lim) => readPostgresPage(db, tenantId, sessionId, afterSeq, lim),
      readFlushWatermark: () => readFlushWatermark(db, tenantId, sessionId),
      readRedisBefore: async (beforeStreamId, lim) => {
        if (!redis) return { entries: [], hasOlder: false, oldestId: null };
        const { entries, hasOlder, oldestId } = await readSessionEventEntriesBefore(
          redis,
          tenantId,
          sessionId,
          beforeStreamId,
          lim,
        );
        return { entries, hasOlder, oldestId };
      },
      readPostgresBefore: (beforeSeq, lim) =>
        readPostgresBefore(db, tenantId, sessionId, beforeSeq, lim),
    };
    return tailAfterFrom(port, cursor, limit);
  }

  async function tailBefore(
    tenantId: TenantId,
    sessionId: SessionId,
    beforeCursor: string | undefined,
    opts: TailAfterOptions = {},
  ): Promise<
    LatestResult | { kind: 'reconcile_required'; reason: ReconcileReason; cursor?: string }
  > {
    const limit = opts.limit ?? DEFAULT_TAIL_LIMIT;
    const port: TailAfterPort = {
      readRedisFrom: async (fromStreamId, lim) => {
        if (!redis) return { entries: [], scanned: 0, lastId: fromStreamId, oldestId: null };
        return readSessionEventEntries(redis, tenantId, sessionId, fromStreamId, lim);
      },
      seekPostgresSequence: (eventId) => seekEventSequence(db, tenantId, sessionId, eventId),
      readPostgresPage: (afterSeq, lim) => readPostgresPage(db, tenantId, sessionId, afterSeq, lim),
      readFlushWatermark: () => readFlushWatermark(db, tenantId, sessionId),
      readRedisBefore: async (beforeStreamId, lim) => {
        if (!redis) return { entries: [], hasOlder: false, oldestId: null };
        const { entries, hasOlder, oldestId } = await readSessionEventEntriesBefore(
          redis,
          tenantId,
          sessionId,
          beforeStreamId,
          lim,
        );
        return { entries, hasOlder, oldestId };
      },
      readPostgresBefore: (beforeSeq, lim) =>
        readPostgresBefore(db, tenantId, sessionId, beforeSeq, lim),
    };
    if (beforeCursor === undefined || beforeCursor.length === 0) {
      return beforeFrom(port, null, limit);
    }
    const decoded = decodeSessionCursor(beforeCursor);
    if (decoded === null) {
      // Refused rather than treated as "from the end": silently restarting a
      // scroll-back at the newest page would loop the reader over the same
      // events forever while it believed it was walking backwards.
      return { kind: 'reconcile_required', reason: 'cursor_malformed' };
    }
    return beforeFrom(
      port,
      {
        // Carried so a hot-origin cursor can still be located in the durable
        // log when the hot window has nothing older than it left.
        ...(decoded.eventId !== undefined ? { eventId: decoded.eventId } : {}),
        ...(decoded.redisStreamId !== undefined ? { redisStreamId: decoded.redisStreamId } : {}),
        ...(decoded.postgresSequence !== undefined
          ? { postgresSequence: decoded.postgresSequence }
          : {}),
      },
      limit,
    );
  }

  async function* live(
    tenantId: TenantId,
    sessionId: SessionId,
    opts: LiveTailOptions,
  ): AsyncIterable<LiveTailItem> {
    const { signal } = opts;
    const perWakeupLimit = opts.perWakeupLimit ?? 200;
    let cursor = opts.cursor;

    // The live buffer rides this same subscription rather than a second one:
    // the reader is fed each durable event as it drains, and read after, so the
    // terminal event orders ahead of any late live frame for the same step.
    const liveReader = redis ? createLiveDeltaReader(redis, tenantId, sessionId) : null;
    for (const seeded of opts.seedEvents ?? []) liveReader?.observe(seeded);

    const wakeupSource = await subscribeSessionWakeup({
      pubsubSubscriber,
      tenantId,
      sessionId,
      signal,
    });

    async function* drainDurable(): AsyncGenerator<LiveTailItem> {
      while (!signal.aborted) {
        const result = await tailAfter(tenantId, sessionId, cursor, { limit: perWakeupLimit });
        if (result.kind === 'reconcile_required') {
          throw new SessionTailReconcileError(result.reason, result.cursor);
        }
        for (const [i, event] of result.events.entries()) {
          if (signal.aborted) return;
          liveReader?.observe(event);
          yield { kind: 'event', event, cursor: result.eventCursors[i] ?? result.nextCursor };
        }
        // Advance by what the reader positioned us at, never by the last
        // event's id: an event id is not a position, and deriving one from it
        // is what forced the whole-stream scan this reader exists to remove.
        cursor = result.nextCursor;
        if (!result.hasMore) break;
      }
    }

    async function* readLive(): AsyncGenerator<LiveTailItem> {
      if (!liveReader) return;
      for (const frame of await liveReader.read(signal)) {
        if (signal.aborted) return;
        yield { kind: 'live_delta', frame };
      }
    }

    try {
      // Initial drain — durable first, then the in-flight step's partial so a
      // mid-step joiner sees the text already streamed.
      yield* drainDurable();
      yield* readLive();

      // Wakeup loop. A live-delta flush wakes us to re-read the cheap buffer
      // but does NOT drain the durable stream; a durable notification — an
      // append, or a Pub/Sub reconnect — does both.
      while (!signal.aborted) {
        const signalKind = await wakeupSource.next();
        if (signalKind === 'abort' || signal.aborted) return;
        if (signalKind.durable) yield* drainDurable();
        yield* readLive();
      }
    } finally {
      await wakeupSource.close();
    }
  }

  return { tailAfter, tailBefore, live };
}

export class SessionTailReconcileError extends Error {
  constructor(
    readonly reason: ReconcileReason,
    readonly cursor?: string,
  ) {
    super(`SessionTail reconcile required: ${reason}`);
    this.name = 'SessionTailReconcileError';
  }
}
