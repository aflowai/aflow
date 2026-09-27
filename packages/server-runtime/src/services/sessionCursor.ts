/**
 * The position a client resumes a session tail from.
 *
 * Clients treat this as opaque and hand it back unread, so the encoding is the
 * contract, not the decoded shape.
 *
 * It carries a **position**, never authority. Tenant and session come from the
 * authenticated request, so a cursor minted in another session is not a
 * privilege — it is a position that will not resolve. That is why it is
 * unsigned: there is nothing here worth forging.
 *
 * The cursor exists because an event id and a Redis stream id are different
 * address spaces. `XRANGE` seeks by stream id; the durable log orders by
 * sequence; the client only ever knew the event id. Carrying all three lets the
 * reader seek directly instead of reading a stream from the beginning to find
 * out where it already was.
 */
import { isValidStreamId } from '@aflow/redis';

/** Bumped only when the decoded shape changes incompatibly. */
export const SESSION_CURSOR_VERSION = 1;

/**
 * Rejected before any parse, so a hostile cursor costs one length check rather
 * than a datastore round trip. Generous against the real shape — a uuid, a
 * stream id and a sequence — and far below any transport limit.
 */
export const MAX_ENCODED_CURSOR_LENGTH = 512;

export interface SessionCursor {
  /**
   * The event the client last saw, when there is one.
   *
   * Absent only when the reader had to step over stream entries it could not
   * parse: those have no event to name, and a position that cannot advance past
   * them is a position the drain spins on forever.
   */
  eventId?: string;
  /** Present when the event was read from Redis. */
  redisStreamId?: string;
  /** Present when the event was read from Postgres. */
  postgresSequence?: number;
}

/** Short keys: the encoded form travels in query strings and SSE headers. */
interface WireCursor {
  v: number;
  e?: string;
  r?: string;
  p?: number;
}

function toBase64Url(json: string): string {
  return Buffer.from(json, 'utf8').toString('base64url');
}

function fromBase64Url(raw: string): string | null {
  // `base64url` decoding is lenient — it ignores characters outside the
  // alphabet rather than failing — so an explicit charset check is what makes
  // a malformed cursor observable instead of silently decoding to garbage.
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    return Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function encodeSessionCursor(cursor: SessionCursor): string {
  const wire: WireCursor = { v: SESSION_CURSOR_VERSION };
  if (cursor.eventId !== undefined) wire.e = cursor.eventId;
  if (cursor.redisStreamId !== undefined) wire.r = cursor.redisStreamId;
  if (cursor.postgresSequence !== undefined) wire.p = cursor.postgresSequence;
  return toBase64Url(JSON.stringify(wire));
}

/**
 * `null` for anything this server cannot position from: malformed, over-long,
 * an unknown version, or a cursor carrying no position at all.
 *
 * A cursor with only an `eventId` is malformed rather than a slow path. Every
 * mint site knows where it read from, so one that does not is a bug in this
 * process — accepting it would reintroduce the whole-stream scan this cursor
 * exists to remove, silently and only in production.
 */
export function decodeSessionCursor(raw: string): SessionCursor | null {
  if (raw.length === 0 || raw.length > MAX_ENCODED_CURSOR_LENGTH) return null;

  const json = fromBase64Url(raw);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const wire = parsed as Partial<WireCursor>;
  if (wire.v !== SESSION_CURSOR_VERSION) return null;

  const cursor: SessionCursor = {};
  if (wire.e !== undefined) {
    if (typeof wire.e !== 'string' || wire.e.length === 0) return null;
    cursor.eventId = wire.e;
  }

  if (wire.r !== undefined) {
    if (typeof wire.r !== 'string' || !isValidStreamId(wire.r)) return null;
    cursor.redisStreamId = wire.r;
  }
  if (wire.p !== undefined) {
    if (typeof wire.p !== 'number' || !Number.isSafeInteger(wire.p) || wire.p < 0) return null;
    cursor.postgresSequence = wire.p;
  }

  if (cursor.redisStreamId === undefined && cursor.postgresSequence === undefined) return null;

  return cursor;
}
