import { describe, it, expect } from 'vitest';
import type { SessionEvent as RedisRunEvent, SessionEventEntry } from '@aflow/redis';
import { compareRedisStreamIds } from '@aflow/redis';
import type { EventLogRow } from '@aflow/database';
import { tailAfterFrom, beforeFrom, type TailAfterPort } from './sessionTail.js';
import { decodeSessionCursor, encodeSessionCursor } from './sessionCursor.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const TS = 1_700_000_000_000;

function redisEvent(id: string): RedisRunEvent {
  return {
    eventId: id,
    eventType: 'StepSucceeded',
    timestamp: TS,
    sessionId: SESSION_ID,
  } as RedisRunEvent;
}

/** Stream ids are assigned in list order: the first entry is `1-0`, and so on. */
function entries(ids: string[], startAt = 1): SessionEventEntry[] {
  return ids.map((id, i) => ({ id: `${String(startAt + i)}-0`, event: redisEvent(id) }));
}

function pgRow(id: string, seq: number): EventLogRow {
  return {
    eventId: id,
    eventType: 'StepSucceeded',
    eventVersion: 1,
    sessionId: SESSION_ID,
    stepExecutionId: null,
    parentStepExecutionId: null,
    stepId: null,
    stepType: null,
    attempt: 1,
    timestamp: new Date(TS),
    payloadRef: null,
    errorRef: null,
    requestedInputRef: null,
    operationId: null,
    idempotencyKey: `${id}:flushed`,
    sequenceNumber: seq,
    envelope: redisEvent(id),
  } as unknown as EventLogRow;
}

interface FakePort extends TailAfterPort {
  /** Every `fromStreamId` the reader sought to, in order. */
  redisSeeks: string[];
  /** Entries Redis actually returned, summed across reads. */
  redisEntriesRead: number;
  /** Order of port calls, for asserting the watermark is read before the page. */
  callOrder: string[];
}

function makePort(opts: {
  redis?: SessionEventEntry[];
  postgres?: EventLogRow[];
  watermark?: string | null;
  /** Fires once, after the watermark read, to simulate a concurrent flush. */
  onWatermarkRead?: () => void;
  /** Entries per read that parse-fail and are dropped by the reader. */
  droppedPerRead?: number;
}): FakePort {
  const redis = opts.redis ?? [];
  const postgres = opts.postgres ?? [];
  const port: FakePort = {
    redisSeeks: [],
    redisEntriesRead: 0,
    callOrder: [],
    readRedisFrom: async (fromStreamId, limit) => {
      port.redisSeeks.push(fromStreamId);
      port.callOrder.push('redis');
      const after =
        fromStreamId === '0'
          ? redis
          : redis.filter((e) => compareRedisStreamIds(e.id, fromStreamId) > 0);
      const page = after.slice(0, limit);
      port.redisEntriesRead += page.length;
      // `scanned` counts what the range returned; `dropped` models entries this
      // revision could not parse, which occupy the window but never appear.
      const dropped = opts.droppedPerRead ?? 0;
      return {
        entries: page.slice(0, Math.max(0, page.length - dropped)),
        scanned: page.length,
        lastId: page[page.length - 1]?.id ?? fromStreamId,
        oldestId: redis[0]?.id ?? null,
      };
    },
    seekPostgresSequence: async (eventId: string) => {
      port.callOrder.push('seek');
      return postgres.find((r) => r.eventId === eventId)?.sequenceNumber ?? null;
    },
    readPostgresPage: async (afterSeq: number | null, limit: number) => {
      port.callOrder.push('page');
      const rows = postgres.filter((r) => (afterSeq === null ? true : r.sequenceNumber > afterSeq));
      return rows.slice(0, limit);
    },
    readFlushWatermark: async () => {
      port.callOrder.push('watermark');
      const w = opts.watermark ?? null;
      opts.onWatermarkRead?.();
      return w;
    },
    readRedisBefore: async (beforeStreamId: string | null, limit: number) => {
      port.callOrder.push('redisBefore');
      const older =
        beforeStreamId === null
          ? redis
          : redis.filter((e) => compareRedisStreamIds(e.id, beforeStreamId) < 0);
      const page = older.slice(Math.max(0, older.length - limit));
      return {
        entries: page,
        hasOlder: older.length > limit,
        oldestId: redis[0]?.id ?? null,
      };
    },
    readPostgresBefore: async (beforeSeq: number | null, limit: number) => {
      port.callOrder.push('pgBefore');
      const older =
        beforeSeq === null ? postgres : postgres.filter((r) => r.sequenceNumber < beforeSeq);
      return older.slice(Math.max(0, older.length - limit));
    },
  };
  return port;
}

/** The cursor a client would hold for the Nth Redis entry (0-based). */
function redisCursor(list: SessionEventEntry[], index: number): string {
  const entry = list[index];
  if (!entry) throw new Error('no such entry');
  return encodeSessionCursor({ eventId: entry.event.eventId, redisStreamId: entry.id });
}

function pgCursor(row: EventLogRow): string {
  return encodeSessionCursor({ eventId: row.eventId, postgresSequence: row.sequenceNumber });
}

function expectEvents(result: Awaited<ReturnType<typeof tailAfterFrom>>) {
  if (result.kind !== 'events') throw new Error(`expected events, got ${result.kind}`);
  return result;
}

describe('tailAfterFrom — cursor inside the retained Redis window', () => {
  it('returns what follows the cursor', async () => {
    const redis = entries(['a', 'b', 'c', 'd', 'e']);
    const port = makePort({ redis });
    const result = expectEvents(await tailAfterFrom(port, redisCursor(redis, 1), 100));
    expect(result.events.map((e) => e.eventId)).toEqual(['c', 'd', 'e']);
    expect(result.hasMore).toBe(false);
    expect(decodeSessionCursor(result.nextCursor)?.eventId).toBe('e');
  });

  it('seeks to the cursor rather than reading the stream from the start', async () => {
    // The property the whole change exists for. A reader that scans would ask
    // Redis from '0' and inspect everything before the cursor.
    const redis = entries(Array.from({ length: 1000 }, (_, i) => `evt-${String(i)}`));
    const port = makePort({ redis });
    const result = expectEvents(await tailAfterFrom(port, redisCursor(redis, 900), 5));

    expect(port.redisSeeks).toEqual(['901-0']);
    expect(port.redisSeeks).not.toContain('0');
    // Cost is the page asked for, not the 900 entries before it.
    expect(port.redisEntriesRead).toBeLessThanOrEqual(6);
    expect(result.events.map((e) => e.eventId)).toEqual([
      'evt-901',
      'evt-902',
      'evt-903',
      'evt-904',
      'evt-905',
    ]);
  });

  it('costs one empty read when nothing has happened since the cursor', async () => {
    // The idle case: what the 500ms poll used to pay a full re-parse for.
    const redis = entries(['a', 'b', 'c']);
    const port = makePort({ redis });
    const result = expectEvents(await tailAfterFrom(port, redisCursor(redis, 2), 100));
    expect(result.events).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(port.redisEntriesRead).toBe(0);
  });

  it('holds its position when there is nothing new', async () => {
    const redis = entries(['a', 'b', 'c']);
    const cursor = redisCursor(redis, 2);
    const port = makePort({ redis });
    const result = expectEvents(await tailAfterFrom(port, cursor, 100));
    expect(result.nextCursor).toBe(cursor);
  });

  it('caps to limit and reports hasMore', async () => {
    const redis = entries(['a', 'b', 'c', 'd', 'e']);
    const port = makePort({ redis });
    const result = expectEvents(await tailAfterFrom(port, redisCursor(redis, 0), 2));
    expect(result.events.map((e) => e.eventId)).toEqual(['b', 'c']);
    expect(result.hasMore).toBe(true);
    expect(decodeSessionCursor(result.nextCursor)?.redisStreamId).toBe('3-0');
  });
});

describe('tailAfterFrom — cursor trimmed out of Redis', () => {
  it('falls back to Postgres by sequence, then appends the Redis tail', async () => {
    // Redis retains only d..f; the cursor names an entry older than that.
    const redis = entries(['d', 'e', 'f'], 4);
    const port = makePort({
      redis,
      postgres: [pgRow('a', 1), pgRow('b', 2), pgRow('c', 3), pgRow('d', 4), pgRow('e', 5)],
      watermark: '5-0',
    });
    const stale = encodeSessionCursor({ eventId: 'b', redisStreamId: '2-0', postgresSequence: 2 });
    const result = expectEvents(await tailAfterFrom(port, stale, 100));
    expect(result.events.map((e) => e.eventId)).toEqual(['c', 'd', 'e', 'f']);
  });

  it('seeks Postgres by eventId when the cursor carries no sequence', async () => {
    // A Redis-origin cursor normally has no `postgresSequence` — the event may
    // not have been flushed when it was minted — so the fallback cannot assume
    // one is present.
    const redis = entries(['d', 'e'], 4);
    const port = makePort({
      redis,
      postgres: [pgRow('b', 2), pgRow('c', 3), pgRow('d', 4)],
      watermark: '4-0',
    });
    const redisOnly = encodeSessionCursor({ eventId: 'b', redisStreamId: '2-0' });
    const result = expectEvents(await tailAfterFrom(port, redisOnly, 100));
    expect(port.callOrder).toContain('seek');
    expect(result.events.map((e) => e.eventId)).toEqual(['c', 'd', 'e']);
  });

  it('reconciles when the cursor is gone from Redis and was never durable', async () => {
    const port = makePort({ redis: entries(['d', 'e'], 4), postgres: [] });
    const stale = encodeSessionCursor({ eventId: 'b', redisStreamId: '2-0' });
    const result = await tailAfterFrom(port, stale, 100);
    expect(result.kind).toBe('reconcile_required');
    if (result.kind !== 'reconcile_required') throw new Error('expected reconcile');
    expect(result.reason).toBe('cursor_evicted');
  });

  it('treats an empty Redis stream as no confirmation of position', async () => {
    const port = makePort({ redis: [], postgres: [pgRow('a', 1), pgRow('b', 2)] });
    const cursor = encodeSessionCursor({ eventId: 'a', redisStreamId: '1-0', postgresSequence: 1 });
    const result = expectEvents(await tailAfterFrom(port, cursor, 100));
    expect(result.events.map((e) => e.eventId)).toEqual(['b']);
  });
});

describe('tailAfterFrom — malformed cursor', () => {
  it('reconciles rather than scanning, and touches no datastore', async () => {
    const port = makePort({ redis: entries(['a', 'b']), postgres: [pgRow('a', 1)] });
    const result = await tailAfterFrom(port, 'not-a-cursor', 100);
    expect(result.kind).toBe('reconcile_required');
    if (result.kind !== 'reconcile_required') throw new Error('expected reconcile');
    expect(result.reason).toBe('cursor_malformed');
    expect(port.callOrder).toEqual([]);
  });

  it('reconciles a bare event id, which is what the old cursor was', async () => {
    const port = makePort({ redis: entries(['a', 'b']) });
    const result = await tailAfterFrom(port, '3f2a1c4e-9b8d-4a11-9f2e-7c1d5b6a0e33', 100);
    expect(result.kind).toBe('reconcile_required');
  });
});

describe('tailAfterFrom — the Postgres→Redis bridge', () => {
  it('reads the flush watermark before the Postgres page', async () => {
    // Ordering is the invariant: a watermark read afterwards could name a
    // position past the page just taken, and the Redis read would start beyond
    // events the page never covered.
    const port = makePort({
      redis: entries(['c'], 3),
      postgres: [pgRow('a', 1), pgRow('b', 2)],
      watermark: '2-0',
    });
    await tailAfterFrom(port, undefined, 100);
    expect(port.callOrder.indexOf('watermark')).toBeLessThan(port.callOrder.indexOf('page'));
  });

  it('loses no event when a flush commits between the watermark and the page', async () => {
    // The race the ordering exists to survive. The flush moves 'c' into
    // Postgres after the watermark was captured at '1-0'; reading Redis from
    // the older watermark re-covers it, and the dedupe removes the overlap.
    const postgres = [pgRow('a', 1), pgRow('b', 2)];
    const port = makePort({
      redis: entries(['b', 'c', 'd'], 2),
      postgres,
      watermark: '1-0',
      onWatermarkRead: () => {
        postgres.push(pgRow('c', 3));
      },
    });
    const result = expectEvents(await tailAfterFrom(port, undefined, 100));
    expect(result.events.map((e) => e.eventId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('starts the Redis read at the watermark, not at the stream head', async () => {
    const port = makePort({
      redis: entries(['a', 'b', 'c']),
      postgres: [pgRow('a', 1), pgRow('b', 2)],
      watermark: '2-0',
    });
    await tailAfterFrom(port, undefined, 100);
    expect(port.redisSeeks).toEqual(['2-0']);
  });
});

describe('tailAfterFrom — initial connect (no cursor)', () => {
  it('returns Redis events when Postgres is empty', async () => {
    const port = makePort({ redis: entries(['a', 'b', 'c']) });
    const result = expectEvents(await tailAfterFrom(port, undefined, 100));
    expect(result.events.map((e) => e.eventId)).toEqual(['a', 'b', 'c']);
  });

  it('returns Postgres events when Redis is empty', async () => {
    const port = makePort({ postgres: [pgRow('a', 1), pgRow('b', 2)] });
    const result = expectEvents(await tailAfterFrom(port, undefined, 100));
    expect(result.events.map((e) => e.eventId)).toEqual(['a', 'b']);
  });

  it('merges durable history then the Redis tail', async () => {
    const port = makePort({
      redis: entries(['d', 'e', 'f'], 4),
      postgres: [pgRow('a', 1), pgRow('b', 2), pgRow('c', 3)],
      watermark: '3-0',
    });
    const result = expectEvents(await tailAfterFrom(port, undefined, 100));
    expect(result.events.map((e) => e.eventId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('dedupes the overlap when both stores carry recent events', async () => {
    const port = makePort({
      redis: entries(['c', 'd', 'e', 'f'], 3),
      postgres: [pgRow('a', 1), pgRow('b', 2), pgRow('c', 3), pgRow('d', 4), pgRow('e', 5)],
      watermark: '2-0',
    });
    const result = expectEvents(await tailAfterFrom(port, undefined, 100));
    expect(result.events.map((e) => e.eventId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('caps at limit and signals hasMore when Postgres alone exceeds the page', async () => {
    const port = makePort({
      redis: entries(['d'], 4),
      postgres: [pgRow('a', 1), pgRow('b', 2), pgRow('c', 3)],
    });
    const result = expectEvents(await tailAfterFrom(port, undefined, 2));
    expect(result.events.map((e) => e.eventId)).toEqual(['a', 'b']);
    expect(result.hasMore).toBe(true);
  });

  it('hands back a seekable position, never a bare event id', async () => {
    const port = makePort({ redis: entries(['a', 'b']) });
    const result = expectEvents(await tailAfterFrom(port, undefined, 100));
    const decoded = decodeSessionCursor(result.nextCursor);
    expect(decoded?.eventId).toBe('b');
    expect(decoded?.redisStreamId).toBe('2-0');
  });

  it('emits an empty position for a session with no events', async () => {
    const port = makePort({});
    const result = expectEvents(await tailAfterFrom(port, undefined, 100));
    expect(result.events).toEqual([]);
    expect(result.nextCursor).toBe('');
  });
});

describe('tailAfterFrom — resuming from a durable position', () => {
  it('never replays events the client already has, even with Redis holding them', async () => {
    // The subtlest property in the reader. A durable event is at or before the
    // flush watermark — the worker advances it in the same transaction that
    // writes the rows — and the Redis read starts *exclusively* after that
    // watermark. So a Postgres-origin cursor cannot be handed anything at or
    // before itself, even while Redis still retains those same events.
    const rows = [pgRow('a', 1), pgRow('b', 2), pgRow('c', 3)];
    const port = makePort({
      // Redis still holds a..e, including the three already flushed.
      redis: entries(['a', 'b', 'c', 'd', 'e']),
      postgres: rows,
      // Durable through 'c'.
      watermark: '3-0',
    });
    const cursor = pgCursor(rows[1] as EventLogRow);
    const result = expectEvents(await tailAfterFrom(port, cursor, 100));

    expect(result.events.map((e) => e.eventId)).toEqual(['c', 'd', 'e']);
    expect(result.events.map((e) => e.eventId)).not.toContain('a');
    expect(result.events.map((e) => e.eventId)).not.toContain('b');
  });

  it('continues from a Postgres cursor and picks up the Redis tail', async () => {
    const rows = [pgRow('a', 1), pgRow('b', 2), pgRow('c', 3)];
    const port = makePort({
      redis: entries(['d', 'e'], 4),
      postgres: rows,
      watermark: '3-0',
    });
    const cursor = pgCursor(rows[1] as EventLogRow);
    const result = expectEvents(await tailAfterFrom(port, cursor, 100));
    expect(result.events.map((e) => e.eventId)).toEqual(['c', 'd', 'e']);
  });
});

describe('tailAfterFrom — entries the reader could not parse', () => {
  it('reports more to come when a dropped entry occupied the page', async () => {
    // An event type this revision does not know still fills a slot in the
    // range. Counting only the survivors would say "nothing follows" while
    // events sat past the page — and with no poll behind the drain, the
    // subscription would stop there and stay stopped.
    const redis = entries(['a', 'b', 'c', 'd', 'e']);
    const port = makePort({ redis, droppedPerRead: 1 });
    const result = expectEvents(await tailAfterFrom(port, redisCursor(redis, 0), 3));

    expect(result.hasMore).toBe(true);
  });

  it('advances the cursor to a parsed entry, never to one it dropped', async () => {
    const redis = entries(['a', 'b', 'c', 'd']);
    const port = makePort({ redis, droppedPerRead: 1 });
    const result = expectEvents(await tailAfterFrom(port, redisCursor(redis, 0), 10));
    const decoded = decodeSessionCursor(result.nextCursor);

    expect(result.events.map((e) => e.eventId)).toEqual(['b', 'c']);
    expect(decoded?.eventId).toBe('c');
  });
});

describe('tailAfterFrom — per-event positions', () => {
  it('gives every event its own resume position', async () => {
    // A live subscriber emits these one at a time. A page-end cursor alone
    // would let a client that disconnects mid-page resume past events it never
    // received.
    const redis = entries(['a', 'b', 'c']);
    const port = makePort({ redis });
    const result = expectEvents(await tailAfterFrom(port, undefined, 100));

    expect(result.eventCursors).toHaveLength(result.events.length);
    expect(result.eventCursors.map((c) => decodeSessionCursor(c)?.eventId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('positions durable events by their sequence', async () => {
    const port = makePort({ postgres: [pgRow('a', 1), pgRow('b', 2)] });
    const result = expectEvents(await tailAfterFrom(port, undefined, 100));

    expect(result.eventCursors.map((c) => decodeSessionCursor(c)?.postgresSequence)).toEqual([
      1, 2,
    ]);
  });
});

describe('tailAfterFrom — a page that parses nothing', () => {
  it('advances past entries it could not parse instead of re-reading them', async () => {
    // A run of event types this revision does not know. Reporting more to come
    // while holding the cursor still is a drain that reads the same range
    // forever — a hot loop, and the one thing worse than the scan it replaced.
    const redis = entries(['a', 'b', 'c', 'd', 'e']);
    const port = makePort({ redis, droppedPerRead: 99 });
    const result = expectEvents(await tailAfterFrom(port, redisCursor(redis, 0), 2));

    expect(result.events).toEqual([]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBe(redisCursor(redis, 0));

    const decoded = decodeSessionCursor(result.nextCursor);
    // Past everything the range inspected, since none of it was deliverable.
    expect(decoded?.redisStreamId).toBe('4-0');
    // Nothing parsed, so there is no event to name — and requiring one here is
    // what would have kept the cursor pinned.
    expect(decoded?.eventId).toBeUndefined();
  });

  it('terminates rather than re-reading the same range', async () => {
    // The drain loops while `hasMore`. Stepping the cursor past what was
    // scanned is what lets the next read reach the end and stop.
    const redis = entries(['a', 'b', 'c']);
    const port = makePort({ redis, droppedPerRead: 99 });

    const first = expectEvents(await tailAfterFrom(port, redisCursor(redis, 0), 1));
    expect(first.hasMore).toBe(true);

    const second = expectEvents(await tailAfterFrom(port, first.nextCursor, 1));
    expect(second.hasMore).toBe(false);
  });
});

describe('tailAfterFrom — the durable path also steps over what it cannot parse', () => {
  it('advances when the Redis tail scans entries and parses none', async () => {
    // Same trap as the seek path, on the other branch: reporting more to come
    // from a position that never moved is a drain re-reading one page forever.
    const port = makePort({
      redis: entries(['x', 'y', 'z']),
      postgres: [pgRow('a', 1)],
      watermark: '1-0',
      droppedPerRead: 99,
    });
    const result = expectEvents(await tailAfterFrom(port, undefined, 10));

    expect(result.events.map((e) => e.eventId)).toEqual(['a']);
    const decoded = decodeSessionCursor(result.nextCursor);
    // Past the scanned tail, not parked on the durable row before it.
    expect(decoded?.redisStreamId).toBe('3-0');
  });
});

/**
 * What a fresh mount actually receives.
 *
 * The WS topic opens with no cursor and asks for one page of 500, and never
 * looks at `hasMore`. These record which end of the history that page comes
 * from, because "the newest 500" and "the oldest 500" are the difference
 * between a capped view and a wrong one.
 */
describe('the forward read from no cursor starts at the beginning', () => {
  it('returns the OLDEST events, not the newest', async () => {
    const port = makePort({ redis: entries(['e1', 'e2', 'e3', 'e4', 'e5']) });

    const result = expectEvents(await tailAfterFrom(port, undefined, 3));

    expect(result.events.map((e) => e.eventId)).toEqual(['e1', 'e2', 'e3']);
  });

  it('reports that more exists — the caller has to act on it', async () => {
    const port = makePort({ redis: entries(['e1', 'e2', 'e3', 'e4', 'e5']) });

    const result = expectEvents(await tailAfterFrom(port, undefined, 3));

    expect(result.hasMore).toBe(true);
  });

  it('leaves the newest events unreachable in a single page', async () => {
    // The consequence: a subscriber that drains once and then tails live never
    // sees e4/e5 at all — they are older than the live tail and past the page.
    const port = makePort({ redis: entries(['e1', 'e2', 'e3', 'e4', 'e5']) });

    const result = expectEvents(await tailAfterFrom(port, undefined, 3));

    expect(result.events.map((e) => e.eventId)).not.toContain('e5');
  });
});

/**
 * What a fresh mount should receive.
 *
 * The defect these replace: a page taken from the start of a long session and a
 * live tail taken from its end leave everything between them unreachable.
 * Anchoring the page to the newest event is what removes the gap rather than
 * narrowing it.
 */
describe('beforeFrom — the newest page', () => {
  it('returns the NEWEST page, which is the end the live tail continues from', async () => {
    const port = makePort({ redis: entries(['e1', 'e2', 'e3', 'e4', 'e5']) });

    const result = await beforeFrom(port, null, 3);

    expect(result.events.map((e) => e.eventId)).toEqual(['e3', 'e4', 'e5']);
  });

  it('keeps events chronological, because the reducer folds them in order', async () => {
    // `xrevrange` answers newest-first; folding in that order rebuilds the
    // wrong state, so the reversal has to happen before the caller sees it.
    const port = makePort({ redis: entries(['e1', 'e2', 'e3', 'e4', 'e5']) });

    const result = await beforeFrom(port, null, 5);

    expect(result.events.map((e) => e.eventId)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('resumes the live tail at the last event it returned', async () => {
    // A tail position past the final returned event would skip the interval
    // between them — the same class of gap, moved rather than fixed.
    const list = entries(['e1', 'e2', 'e3', 'e4', 'e5']);
    const port = makePort({ redis: list });

    const result = await beforeFrom(port, null, 3);

    expect(result.nextCursor).toBe(redisCursor(list, 4));
    expect(result.eventCursors).toHaveLength(result.events.length);
  });

  it('says when older history exists', async () => {
    const port = makePort({ redis: entries(['e1', 'e2', 'e3', 'e4', 'e5']) });
    expect((await beforeFrom(port, null, 3)).hasOlder).toBe(true);
  });

  it('says when it does not', async () => {
    const port = makePort({ redis: entries(['e1', 'e2']) });
    expect((await beforeFrom(port, null, 5)).hasOlder).toBe(false);
  });

  it('never touches the durable log when Redis holds a full page', async () => {
    // The steady state for any session recent enough to be open.
    const port = makePort({ redis: entries(['e1', 'e2', 'e3']), postgres: [pgRow('old', 1)] });

    await beforeFrom(port, null, 3);

    expect(port.callOrder).not.toContain('pgBefore');
  });

  it('fills from the durable log when Redis is short, oldest first', async () => {
    const port = makePort({
      redis: entries(['e4', 'e5']),
      postgres: [pgRow('e1', 1), pgRow('e2', 2), pgRow('e3', 3)],
    });

    const result = await beforeFrom(port, null, 5);

    expect(result.events.map((e) => e.eventId)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('does not show an event twice when it sits in both stores', async () => {
    // The flush window leaves the same event durable and hot at once.
    const port = makePort({
      redis: entries(['e2', 'e3']),
      postgres: [pgRow('e1', 1), pgRow('e2', 2)],
    });

    const result = await beforeFrom(port, null, 4);

    expect(result.events.map((e) => e.eventId)).toEqual(['e1', 'e2', 'e3']);
  });

  it('drops the oldest when both stores overfill the page', async () => {
    const port = makePort({
      redis: entries(['e4', 'e5']),
      postgres: [pgRow('e1', 1), pgRow('e2', 2), pgRow('e3', 3)],
    });

    const result = await beforeFrom(port, null, 3);

    expect(result.events.map((e) => e.eventId)).toEqual(['e3', 'e4', 'e5']);
    expect(result.hasOlder).toBe(true);
  });

  it('handles an empty session without inventing a position', async () => {
    const result = await beforeFrom(makePort({}), null, 10);

    expect(result.events).toEqual([]);
    expect(result.nextCursor).toBe('');
    expect(result.hasOlder).toBe(false);
  });
});

/**
 * Walking backwards from a returned position.
 *
 * The newest page is only half the fix: without a way to ask for what sits
 * behind it, a long session is still a truncated one — it just truncates at the
 * useful end instead of the useless one.
 */
describe('beforeFrom — paging back', () => {
  const five = () => entries(['e1', 'e2', 'e3', 'e4', 'e5']);

  it('returns the page immediately older than the position given', async () => {
    const list = five();
    const port = makePort({ redis: list });

    // Page 1 is e4,e5; its oldest is e4, so page 2 must end at e3.
    const older = await beforeFrom(port, { redisStreamId: list[3]!.id }, 2);

    expect(older.events.map((e) => e.eventId)).toEqual(['e2', 'e3']);
  });

  it('never repeats the event the caller paged back from', async () => {
    // An inclusive range would hand back the boundary event on every page and
    // spend one slot of each page re-delivering it.
    const list = five();
    const port = makePort({ redis: list });

    const older = await beforeFrom(port, { redisStreamId: list[3]!.id }, 2);

    expect(older.events.map((e) => e.eventId)).not.toContain('e4');
  });

  it('offers a position to continue from while history remains', async () => {
    const list = five();
    const first = await beforeFrom(makePort({ redis: list }), null, 2);

    expect(first.hasOlder).toBe(true);
    expect(first.olderCursor).toBeDefined();
  });

  it('offers no position once the history is exhausted', async () => {
    // A cursor with nothing behind it invites a page that returns empty
    // forever, which reads to the client as "still loading".
    const result = await beforeFrom(makePort({ redis: entries(['e1', 'e2']) }), null, 5);

    expect(result.hasOlder).toBe(false);
    expect(result.olderCursor).toBeUndefined();
  });

  it('walks the whole history in pages without gap or repeat', async () => {
    const list = five();
    const port = makePort({ redis: list });

    const seen: string[] = [];
    let cursor: { redisStreamId?: string } | null = null;
    for (let i = 0; i < 5; i++) {
      const page: Awaited<ReturnType<typeof beforeFrom>> = await beforeFrom(port, cursor, 2);
      seen.unshift(...page.events.map((e) => e.eventId));
      if (!page.hasOlder || page.olderCursor === undefined) break;
      const decoded = decodeSessionCursor(page.olderCursor);
      cursor =
        decoded?.redisStreamId !== undefined ? { redisStreamId: decoded.redisStreamId } : null;
    }

    expect(seen).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('crosses into the durable log when the hot stream runs out', async () => {
    const list = entries(['e4', 'e5']);
    const port = makePort({
      redis: list,
      postgres: [pgRow('e1', 1), pgRow('e2', 2), pgRow('e3', 3)],
    });

    const older = await beforeFrom(port, { redisStreamId: list[0]!.id, postgresSequence: 4 }, 3);

    expect(older.events.map((e) => e.eventId)).toEqual(['e1', 'e2', 'e3']);
  });
});

/**
 * A cursor that names a durable row and nothing else.
 *
 * Most real backward cursors are this: once a page reaches past the hot window
 * its oldest event came from Postgres, and `cursorFromPostgresRow` carries a
 * sequence with no stream id. Treating that absence as "no position" sends the
 * next Redis read back to the newest entries — the ones the first page already
 * delivered — and the client renders the same events twice.
 */
describe('beforeFrom — paging past the hot window', () => {
  const hot = () => entries(['e6', 'e7']);
  const durable = [pgRow('e1', 1), pgRow('e2', 2), pgRow('e3', 3), pgRow('e4', 4), pgRow('e5', 5)];

  it('does not re-deliver the newest events when the cursor is durable-only', async () => {
    const port = makePort({ redis: hot(), postgres: durable });

    // What the reader holds after a first page whose oldest event was durable.
    const older = await beforeFrom(port, { postgresSequence: 4 }, 3);

    expect(older.events.map((e) => e.eventId)).not.toContain('e6');
    expect(older.events.map((e) => e.eventId)).not.toContain('e7');
  });

  it('answers a durable-only cursor from the durable log', async () => {
    const port = makePort({ redis: hot(), postgres: durable });

    const older = await beforeFrom(port, { postgresSequence: 4 }, 3);

    expect(older.events.map((e) => e.eventId)).toEqual(['e1', 'e2', 'e3']);
  });

  it('walks a hot-then-durable history with no event appearing twice', async () => {
    const port = makePort({ redis: hot(), postgres: durable });

    const seen: string[] = [];
    let cursor: { redisStreamId?: string; postgresSequence?: number } | null = null;
    for (let i = 0; i < 6; i++) {
      const page: Awaited<ReturnType<typeof beforeFrom>> = await beforeFrom(port, cursor, 3);
      seen.unshift(...page.events.map((e) => e.eventId));
      if (!page.hasOlder || page.olderCursor === undefined) break;
      const d = decodeSessionCursor(page.olderCursor);
      if (d === null) break;
      cursor = {
        ...(d.redisStreamId !== undefined ? { redisStreamId: d.redisStreamId } : {}),
        ...(d.postgresSequence !== undefined ? { postgresSequence: d.postgresSequence } : {}),
      };
    }

    expect(seen).toEqual([...new Set(seen)]);
  });
});

/**
 * Filling a short hot page from the durable log.
 *
 * The durable log holds the hot entries too, for as long as the flush takes to
 * catch up, so "the newest durable rows" and "the hot entries" are largely the
 * same events. Reading the newest ones to fill the page puts the newest events
 * at the FRONT, dedupe drops their hot copies, and the page renders the end of
 * the conversation followed by its middle.
 *
 * Measured on a real 680-event session before the fix: 120 events timestamped
 * 08:08 ahead of 560 timestamped 05:13. The page was not short of events and
 * reported no error — it was simply in the wrong order.
 *
 * Reachable whenever the hot stream holds fewer entries than a page and more
 * than none, which is what retention trimming produces.
 */
describe('beforeFrom — a hot window shorter than the page', () => {
  // e1..e6 durable; e5, e6 still hot as well. A page of 4 needs two durable
  // rows behind the hot pair, and the two it must NOT take are e5/e6 again.
  const ALL = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'];
  const postgres = ALL.map((id, i) => pgRow(id, 100 + i));
  const hot = entries(['e5', 'e6'], 5);

  it('fills from behind the hot window, not from the newest rows', async () => {
    const port = makePort({ redis: hot, postgres });
    const page = await beforeFrom(port, null, 4);
    expect(page.events.map((e) => e.eventId)).toEqual(['e3', 'e4', 'e5', 'e6']);
  });

  it('anchors the durable read on the oldest hot entry', async () => {
    const port = makePort({ redis: hot, postgres });
    await beforeFrom(port, null, 4);
    // Without the seek the reader has no way to know where the hot window
    // starts, and "newest durable rows" is the only thing it can ask for.
    expect(port.callOrder).toContain('seek');
  });

  it('reports nothing older once the page reaches the start of the session', async () => {
    // Hot holds the whole session and the durable log has flushed all of it —
    // the shape that made a fully-loaded conversation keep offering to load
    // more, because the fill was counting rows it had already returned.
    const port = makePort({ redis: entries(ALL, 1), postgres });
    const page = await beforeFrom(port, null, 10);
    expect(page.events.map((e) => e.eventId)).toEqual(ALL);
    expect(page.hasOlder).toBe(false);
  });

  it('still reads the newest durable rows when the hot window never flushed', async () => {
    // The oldest hot entry is in no durable row, so every durable row really
    // is older than the hot window.
    const unflushed = entries(['h1', 'h2'], 90);
    const port = makePort({ redis: unflushed, postgres });
    const page = await beforeFrom(port, null, 4);
    expect(page.events.map((e) => e.eventId)).toEqual(['e5', 'e6', 'h1', 'h2']);
  });

  it('leaves a page the hot window fills on its own alone', async () => {
    const port = makePort({ redis: entries(ALL, 1), postgres });
    const page = await beforeFrom(port, null, 4);
    expect(page.events.map((e) => e.eventId)).toEqual(['e3', 'e4', 'e5', 'e6']);
    expect(port.callOrder).not.toContain('pgBefore');
  });
});

/**
 * Crossing out of the hot window on a cursor the hot window no longer covers.
 *
 * A Redis-origin cursor carries a stream id and no durable sequence. When it
 * names the oldest entry the stream still retains, the exclusive backward read
 * returns nothing — and with nothing to anchor the durable read on, the newest
 * durable rows fall out, which is the page the caller was just shown. A
 * scroll-back that repeats a page reads as the conversation looping, not as a
 * boundary being crossed.
 */
describe('beforeFrom — a hot cursor with nothing older left in the stream', () => {
  const ALL = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'];
  const postgres = ALL.map((id, i) => pgRow(id, 100 + i));

  it('reads the rows before the cursor, not the newest ones', async () => {
    // The stream retains e5 and e6; the caller has paged back to e5.
    const port = makePort({ redis: entries(['e5', 'e6'], 5), postgres });
    const page = await beforeFrom(port, { eventId: 'e5', redisStreamId: '5-0' }, 2);
    expect(page.events.map((e) => e.eventId)).toEqual(['e3', 'e4']);
  });

  it('locates the cursor in the durable log to do it', async () => {
    const port = makePort({ redis: entries(['e5', 'e6'], 5), postgres });
    await beforeFrom(port, { eventId: 'e5', redisStreamId: '5-0' }, 2);
    expect(port.callOrder).toContain('seek');
  });

  it('still reads the newest durable rows when the cursor never reached Postgres', async () => {
    // Nothing durable is newer than an unflushed hot event, so the newest rows
    // genuinely are the ones before it.
    const port = makePort({ redis: entries(['h1', 'h2'], 90), postgres });
    const page = await beforeFrom(port, { eventId: 'h1', redisStreamId: '90-0' }, 2);
    expect(page.events.map((e) => e.eventId)).toEqual(['e5', 'e6']);
  });

  it('reports what is behind the page it returned', async () => {
    const port = makePort({ redis: entries(['e5', 'e6'], 5), postgres });
    const page = await beforeFrom(port, { eventId: 'e5', redisStreamId: '5-0' }, 2);
    expect(page.hasOlder).toBe(true);
    const first = await beforeFrom(port, { eventId: 'e3', redisStreamId: '3-0' }, 10);
    expect(first.hasOlder).toBe(false);
  });
});
