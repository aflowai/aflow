/**
 * The implementations this replaces coerced an unparseable id to `0-0`, which
 * sorts before every real entry. A corrupt cursor therefore compared as "older
 * than everything", and a reader asking for what follows it would replay the
 * whole stream rather than report a bad cursor. Every rejection case here is
 * that behaviour, held closed.
 */
import { describe, it, expect } from 'vitest';
import {
  compareStreamIds,
  isValidStreamId,
  nextStreamId,
  parseStreamId,
  tryParseStreamId,
} from '../streams/streamId.js';

describe('parseStreamId', () => {
  it('parses the full form', () => {
    expect(parseStreamId('1756579200000-3')).toEqual({ ms: 1756579200000, seq: 3 });
  });

  it('parses the ms-only shorthand Redis accepts, defaulting the sequence', () => {
    expect(parseStreamId('1756579200000')).toEqual({ ms: 1756579200000, seq: 0 });
  });

  it("parses the conventional '0' beginning cursor", () => {
    expect(parseStreamId('0')).toEqual({ ms: 0, seq: 0 });
  });

  it.each([
    ['empty', ''],
    ['range bound -', '-'],
    ['range bound +', '+'],
    ['a uuid, which is what the old cursor was', '3f2a1c4e-9b8d-4a11-9f2e-7c1d5b6a0e33'],
    ['negative', '-1-0'],
    ['non-numeric ms', 'abc-0'],
    ['non-numeric seq', '100-abc'],
    ['trailing separator', '100-'],
    ['extra segment', '100-1-2'],
    ['float', '100.5-0'],
    ['whitespace', ' 100-0 '],
  ])('rejects %s', (_label, id) => {
    expect(tryParseStreamId(id)).toBeNull();
    expect(isValidStreamId(id)).toBe(false);
    expect(() => parseStreamId(id)).toThrow(/malformed Redis stream id/);
  });

  it('rejects values beyond safe-integer range rather than rounding them', () => {
    expect(tryParseStreamId('999999999999999999999-0')).toBeNull();
  });
});

describe('compareStreamIds', () => {
  it('orders numerically, where lexicographic ordering lies', () => {
    // The bug the numeric compare exists to prevent.
    expect('10-0' < '9-0').toBe(true);
    expect(compareStreamIds('10-0', '9-0')).toBeGreaterThan(0);
  });

  it('breaks ties on the sequence', () => {
    expect(compareStreamIds('100-1', '100-2')).toBeLessThan(0);
    expect(compareStreamIds('100-2', '100-1')).toBeGreaterThan(0);
    expect(compareStreamIds('100-1', '100-1')).toBe(0);
  });

  it('treats the ms shorthand as sequence zero', () => {
    expect(compareStreamIds('100', '100-0')).toBe(0);
    expect(compareStreamIds('100', '100-1')).toBeLessThan(0);
  });

  it('throws rather than silently ordering a malformed id first', () => {
    expect(() => compareStreamIds('not-an-id', '100-0')).toThrow();
  });
});

describe('nextStreamId', () => {
  it('is the smallest id strictly greater than its input', () => {
    expect(nextStreamId('100-1')).toBe('100-2');
    expect(compareStreamIds(nextStreamId('100-1'), '100-1')).toBeGreaterThan(0);
  });

  it('advances the sequence rather than the timestamp', () => {
    expect(nextStreamId('100-0')).toBe('100-1');
    expect(nextStreamId('100')).toBe('100-1');
  });

  it('throws on a malformed id', () => {
    expect(() => nextStreamId('nope')).toThrow();
  });
});
