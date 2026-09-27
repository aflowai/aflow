import { describe, expect, it } from 'vitest';
import { AppletPointerError } from '../errors.js';
import {
  escapeJsonPointerSegment,
  resolveJsonPointer,
  splitJsonPointer,
  unescapeJsonPointerSegment,
} from '../pointer.js';

describe('escapeJsonPointerSegment', () => {
  it('escapes ~ then /', () => {
    expect(escapeJsonPointerSegment('a/b~c')).toBe('a~1b~0c');
    expect(escapeJsonPointerSegment('~1')).toBe('~01');
    expect(escapeJsonPointerSegment('plain')).toBe('plain');
  });

  it('round-trips through unescape', () => {
    for (const segment of ['a/b', '~', '~0', '~1', '/', 'a~/b', '']) {
      expect(unescapeJsonPointerSegment(escapeJsonPointerSegment(segment))).toBe(segment);
    }
  });
});

describe('unescapeJsonPointerSegment', () => {
  it('decodes ~01 to ~1 (RFC 6901 ordering)', () => {
    expect(unescapeJsonPointerSegment('~01')).toBe('~1');
  });
});

describe('splitJsonPointer', () => {
  it('splits and unescapes segments', () => {
    expect(splitJsonPointer('')).toEqual([]);
    expect(splitJsonPointer('/a/b')).toEqual(['a', 'b']);
    expect(splitJsonPointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(splitJsonPointer('/')).toEqual(['']);
  });

  it('refuses a pointer without a leading slash', () => {
    expect(() => splitJsonPointer('a/b')).toThrowError(AppletPointerError);
  });
});

describe('resolveJsonPointer', () => {
  const doc = {
    budget: 40000,
    tasks: [{ owner: 'karim' }, { owner: 'sara' }],
    'weird/key': { '~tilde': true },
    nothing: null,
    ghost: undefined,
  };

  it('resolves object properties and array indices', () => {
    expect(resolveJsonPointer(doc, '/budget')).toEqual({ found: true, value: 40000 });
    expect(resolveJsonPointer(doc, '/tasks/1/owner')).toEqual({ found: true, value: 'sara' });
    expect(resolveJsonPointer(doc, '')).toEqual({ found: true, value: doc });
    expect(resolveJsonPointer(doc, '/nothing')).toEqual({ found: true, value: null });
  });

  it('resolves escaped segments', () => {
    expect(resolveJsonPointer(doc, '/weird~1key/~0tilde')).toEqual({ found: true, value: true });
  });

  it('reports missing paths as not found', () => {
    expect(resolveJsonPointer(doc, '/absent').found).toBe(false);
    expect(resolveJsonPointer(doc, '/budget/deeper').found).toBe(false);
    expect(resolveJsonPointer(doc, '/tasks/2').found).toBe(false);
    expect(resolveJsonPointer(doc, '/ghost').found).toBe(false);
  });

  it('refuses non-canonical array indices', () => {
    expect(resolveJsonPointer(doc, '/tasks/01').found).toBe(false);
    expect(resolveJsonPointer(doc, '/tasks/-').found).toBe(false);
    expect(resolveJsonPointer(doc, '/tasks/x').found).toBe(false);
  });
});
