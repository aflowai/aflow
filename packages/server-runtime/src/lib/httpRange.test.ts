import { describe, it, expect } from 'vitest';
import { parseByteRangeHeader } from './httpRange.js';

const SIZE = 1000;

describe('parseByteRangeHeader', () => {
  it('serves the whole representation when there is no usable range', () => {
    expect(parseByteRangeHeader(undefined, SIZE)).toEqual({ kind: 'none' });
    expect(parseByteRangeHeader('', SIZE)).toEqual({ kind: 'none' });
    expect(parseByteRangeHeader('items=0-10', SIZE)).toEqual({ kind: 'none' });
    expect(parseByteRangeHeader('bytes=abc-def', SIZE)).toEqual({ kind: 'none' });
    expect(parseByteRangeHeader('bytes=-', SIZE)).toEqual({ kind: 'none' });
    // A backwards range is invalid syntax, not an unsatisfiable range.
    expect(parseByteRangeHeader('bytes=500-100', SIZE)).toEqual({ kind: 'none' });
    // Multi-range would need a multipart/byteranges body.
    expect(parseByteRangeHeader('bytes=0-10,20-30', SIZE)).toEqual({ kind: 'none' });
  });

  it('resolves closed, open-ended, and suffix ranges', () => {
    expect(parseByteRangeHeader('bytes=0-99', SIZE)).toEqual({ kind: 'range', start: 0, end: 99 });
    expect(parseByteRangeHeader('bytes=900-', SIZE)).toEqual({
      kind: 'range',
      start: 900,
      end: 999,
    });
    expect(parseByteRangeHeader('bytes=-100', SIZE)).toEqual({
      kind: 'range',
      start: 900,
      end: 999,
    });
    expect(parseByteRangeHeader(' bytes=0-0 ', SIZE)).toEqual({ kind: 'range', start: 0, end: 0 });
  });

  it('clamps an end past the last byte, and a suffix larger than the document', () => {
    expect(parseByteRangeHeader('bytes=900-5000', SIZE)).toEqual({
      kind: 'range',
      start: 900,
      end: 999,
    });
    expect(parseByteRangeHeader('bytes=-5000', SIZE)).toEqual({
      kind: 'range',
      start: 0,
      end: 999,
    });
  });

  it('reports a start past the end, a zero-length suffix, and any range on an empty doc', () => {
    expect(parseByteRangeHeader('bytes=1000-1100', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRangeHeader('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRangeHeader('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRangeHeader('bytes=0-10', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});
