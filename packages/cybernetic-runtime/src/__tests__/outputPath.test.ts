import { describe, expect, it } from 'vitest';
import { parseOutputPath, readOutputPath, readParsedOutputPath } from '../scheduling/outputPath.js';

describe('parseOutputPath', () => {
  it('parses plain dot paths', () => {
    expect(parseOutputPath('a.b.c')).toEqual([
      { kind: 'key', key: 'a' },
      { kind: 'key', key: 'b' },
      { kind: 'key', key: 'c' },
    ]);
  });

  it('parses [n] indexing after a key', () => {
    expect(parseOutputPath('content[0].text')).toEqual([
      { kind: 'key', key: 'content' },
      { kind: 'index', index: 0 },
      { kind: 'key', key: 'text' },
    ]);
  });

  it('parses chained indexers', () => {
    expect(parseOutputPath('grid[2][10]')).toEqual([
      { kind: 'key', key: 'grid' },
      { kind: 'index', index: 2 },
      { kind: 'index', index: 10 },
    ]);
  });

  it('parses a root-array path (bare indexer segment)', () => {
    expect(parseOutputPath('[1].name')).toEqual([
      { kind: 'index', index: 1 },
      { kind: 'key', key: 'name' },
    ]);
  });

  it('rejects empty path, empty segments, and malformed indexers', () => {
    expect(parseOutputPath('')).toBeNull();
    expect(parseOutputPath('a..b')).toBeNull();
    expect(parseOutputPath('.a')).toBeNull();
    expect(parseOutputPath('a.')).toBeNull();
    expect(parseOutputPath('a[x]')).toBeNull();
    expect(parseOutputPath('a[')).toBeNull();
    expect(parseOutputPath('a]')).toBeNull();
    expect(parseOutputPath('a[1')).toBeNull();
    expect(parseOutputPath('a[1]b')).toBeNull(); // trailing chars after indexer
    expect(parseOutputPath('a[-1]')).toBeNull();
    expect(parseOutputPath('a[1.5]')).toBeNull();
  });
});

describe('readOutputPath', () => {
  const value = {
    status: 'COMPLETE',
    content: [
      { type: 'text', text: '{"publicScore":"0.124"}' },
      { type: 'text', text: 'second' },
    ],
    eval: { score: 0.9, tags: ['a', 'b'] },
    nullField: null,
  };

  it('reads flat keys', () => {
    expect(readOutputPath(value, 'status')).toBe('COMPLETE');
  });

  it('reads nested keys', () => {
    expect(readOutputPath(value, 'eval.score')).toBe(0.9);
  });

  it('reads [n] array elements', () => {
    expect(readOutputPath(value, 'content[0].text')).toBe('{"publicScore":"0.124"}');
    expect(readOutputPath(value, 'content[1].text')).toBe('second');
    expect(readOutputPath(value, 'eval.tags[1]')).toBe('b');
  });

  it('reads root arrays via bare indexer segments', () => {
    expect(readOutputPath([{ name: 'x' }], '[0].name')).toBe('x');
  });

  it('returns undefined for missing keys, out-of-range indexes, and type mismatches', () => {
    expect(readOutputPath(value, 'missing')).toBeUndefined();
    expect(readOutputPath(value, 'content[5].text')).toBeUndefined();
    // key segment into an array (must use [n]) — undefined, not coercion
    expect(readOutputPath(value, 'content.text')).toBeUndefined();
    // index segment into an object — undefined
    expect(readOutputPath(value, 'eval[0]')).toBeUndefined();
    // traversal through a primitive
    expect(readOutputPath(value, 'status.x')).toBeUndefined();
    expect(readOutputPath(null, 'a')).toBeUndefined();
  });

  it('treats an explicit null at the final position as PRESENT (null), not missing', () => {
    expect(readOutputPath(value, 'nullField')).toBeNull();
  });

  it('reads an unparseable path as missing (write-time validation is the loud gate)', () => {
    expect(readOutputPath(value, 'a..b')).toBeUndefined();
  });
});

describe('readParsedOutputPath', () => {
  it('walks pre-parsed segments', () => {
    const segments = parseOutputPath('a[0].b');
    expect(segments).not.toBeNull();
    expect(readParsedOutputPath({ a: [{ b: 42 }] }, segments!)).toBe(42);
  });
});
