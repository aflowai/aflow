/**
 * The encoded form is the contract — clients hand it back unread — so these
 * assert what survives a round trip and, more importantly, what is refused.
 * Every rejection here is a case that would otherwise reach Redis or Postgres
 * as a position, and a cursor that positions nowhere is what makes a reader
 * fall back to scanning a whole stream.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_ENCODED_CURSOR_LENGTH,
  SESSION_CURSOR_VERSION,
  decodeSessionCursor,
  encodeSessionCursor,
} from '../sessionCursor.js';

const EVENT_ID = '3f2a1c4e-9b8d-4a11-9f2e-7c1d5b6a0e33';

describe('session cursor round trip', () => {
  it('carries a Redis position', () => {
    const encoded = encodeSessionCursor({ eventId: EVENT_ID, redisStreamId: '1756579200000-3' });
    expect(decodeSessionCursor(encoded)).toEqual({
      eventId: EVENT_ID,
      redisStreamId: '1756579200000-3',
    });
  });

  it('carries a Postgres position', () => {
    const encoded = encodeSessionCursor({ eventId: EVENT_ID, postgresSequence: 42 });
    expect(decodeSessionCursor(encoded)).toEqual({ eventId: EVENT_ID, postgresSequence: 42 });
  });

  it('carries both when the event is known in both places', () => {
    const encoded = encodeSessionCursor({
      eventId: EVENT_ID,
      redisStreamId: '1756579200000-3',
      postgresSequence: 42,
    });
    expect(decodeSessionCursor(encoded)).toEqual({
      eventId: EVENT_ID,
      redisStreamId: '1756579200000-3',
      postgresSequence: 42,
    });
  });

  it('accepts sequence zero, which is a real position', () => {
    const encoded = encodeSessionCursor({ eventId: EVENT_ID, postgresSequence: 0 });
    expect(decodeSessionCursor(encoded)?.postgresSequence).toBe(0);
  });

  it('is URL-safe, so it survives a query string and an SSE header', () => {
    const encoded = encodeSessionCursor({ eventId: EVENT_ID, redisStreamId: '1756579200000-3' });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  it('stays well inside the length bound for a realistic cursor', () => {
    const encoded = encodeSessionCursor({
      eventId: EVENT_ID,
      redisStreamId: '1756579200000-3',
      postgresSequence: 999999,
    });
    expect(encoded.length).toBeLessThan(MAX_ENCODED_CURSOR_LENGTH);
  });
});

describe('session cursor rejection', () => {
  const encodeRaw = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

  it('rejects a cursor carrying no position at all', () => {
    // The whole point: an eventId alone cannot be sought, and accepting it
    // would silently restore the full-stream scan.
    expect(decodeSessionCursor(encodeRaw({ v: SESSION_CURSOR_VERSION, e: EVENT_ID }))).toBeNull();
  });

  it('rejects the bare event id that used to be the cursor', () => {
    expect(decodeSessionCursor(EVENT_ID)).toBeNull();
  });

  it('rejects an unknown version', () => {
    expect(decodeSessionCursor(encodeRaw({ v: 2, e: EVENT_ID, r: '1756579200000-3' }))).toBeNull();
  });

  it('rejects a malformed stream id rather than seeking to it', () => {
    expect(decodeSessionCursor(encodeRaw({ v: 1, e: EVENT_ID, r: 'not-an-id' }))).toBeNull();
    expect(decodeSessionCursor(encodeRaw({ v: 1, e: EVENT_ID, r: '-' }))).toBeNull();
  });

  it('rejects a non-integer or negative sequence', () => {
    expect(decodeSessionCursor(encodeRaw({ v: 1, e: EVENT_ID, p: -1 }))).toBeNull();
    expect(decodeSessionCursor(encodeRaw({ v: 1, e: EVENT_ID, p: 1.5 }))).toBeNull();
    expect(decodeSessionCursor(encodeRaw({ v: 1, e: EVENT_ID, p: '4' }))).toBeNull();
  });

  it('rejects an empty event id', () => {
    expect(decodeSessionCursor(encodeRaw({ v: 1, e: '', r: '1756579200000-3' }))).toBeNull();
  });

  it('accepts a position that names no event', () => {
    // What the reader mints when a page scans entries none of which parse:
    // there is no event to name, and refusing it would pin the cursor and make
    // the drain re-read the same range forever.
    expect(decodeSessionCursor(encodeRaw({ v: 1, r: '1756579200000-3' }))).toEqual({
      redisStreamId: '1756579200000-3',
    });
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'not base64!'],
    ['base64url of non-JSON', Buffer.from('hello', 'utf8').toString('base64url')],
    ['a JSON array', Buffer.from('[1,2]', 'utf8').toString('base64url')],
    ['a JSON scalar', Buffer.from('"nope"', 'utf8').toString('base64url')],
    ['JSON null', Buffer.from('null', 'utf8').toString('base64url')],
  ])('rejects %s', (_label, raw) => {
    expect(decodeSessionCursor(raw)).toBeNull();
  });

  it('rejects an over-long cursor before parsing it', () => {
    const overLong = 'A'.repeat(MAX_ENCODED_CURSOR_LENGTH + 1);
    expect(decodeSessionCursor(overLong)).toBeNull();
  });
});
