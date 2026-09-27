import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from './frontmatter.js';

function props(input: string): Record<string, unknown> {
  return parseFrontmatter(input).properties;
}

// ============================================================================
// Presence / block extraction
// ============================================================================

describe('parseFrontmatter — presence', () => {
  it('returns no frontmatter when content does not start with ---', () => {
    const r = parseFrontmatter('# Just a heading\n\nBody text');
    expect(r.hadFrontmatter).toBe(false);
    expect(r.properties).toEqual({});
    expect(r.diagnostics).toEqual([]);
  });

  it('returns no frontmatter for a --- that is not the first line', () => {
    const r = parseFrontmatter('intro\n---\ntitle: x\n---\n');
    expect(r.hadFrontmatter).toBe(false);
    expect(r.properties).toEqual({});
  });

  it('parses a leading --- ... --- block', () => {
    const r = parseFrontmatter('---\ntitle: Hello\n---\nbody');
    expect(r.hadFrontmatter).toBe(true);
    expect(r.properties).toEqual({ title: 'Hello' });
  });

  it('accepts ... as a closing marker', () => {
    const r = parseFrontmatter('---\ntitle: Hello\n...\nbody');
    expect(r.hadFrontmatter).toBe(true);
    expect(r.properties).toEqual({ title: 'Hello' });
  });

  it('handles an empty frontmatter block', () => {
    const r = parseFrontmatter('---\n---\nbody');
    expect(r.hadFrontmatter).toBe(true);
    expect(r.properties).toEqual({});
    expect(r.diagnostics).toEqual([]);
  });

  it('treats an unterminated block as absent', () => {
    const r = parseFrontmatter('---\ntitle: Hello\nno closing marker here');
    expect(r.hadFrontmatter).toBe(false);
    expect(r.properties).toEqual({});
  });

  it('closing marker at end of content without trailing newline', () => {
    const r = parseFrontmatter('---\ntitle: Hello\n---');
    expect(r.hadFrontmatter).toBe(true);
    expect(r.properties).toEqual({ title: 'Hello' });
  });
});

// ============================================================================
// BOM + CRLF normalization
// ============================================================================

describe('parseFrontmatter — BOM & line endings', () => {
  it('strips a leading UTF-8 BOM before detecting the block', () => {
    const r = parseFrontmatter('﻿---\ntitle: Hello\n---\nbody');
    expect(r.hadFrontmatter).toBe(true);
    expect(r.properties).toEqual({ title: 'Hello' });
  });

  it('normalizes CRLF line endings', () => {
    const r = parseFrontmatter('---\r\ntitle: Hello\r\ncount: 3\r\n---\r\nbody');
    expect(r.hadFrontmatter).toBe(true);
    expect(r.properties).toEqual({ title: 'Hello', count: 3 });
  });

  it('normalizes lone CR line endings', () => {
    const r = parseFrontmatter('---\rtitle: Hello\r---\rbody');
    expect(r.hadFrontmatter).toBe(true);
    expect(r.properties).toEqual({ title: 'Hello' });
  });
});

// ============================================================================
// Value-type contract
// ============================================================================

describe('parseFrontmatter — value types', () => {
  it('parses a plain string', () => {
    expect(props('---\ntitle: Hello World\n---')).toEqual({ title: 'Hello World' });
  });

  it('parses an integer number', () => {
    expect(props('---\ncount: 42\n---')).toEqual({ count: 42 });
  });

  it('parses a negative and a float number', () => {
    expect(props('---\na: -7\nb: 3.14\n---')).toEqual({ a: -7, b: 3.14 });
  });

  it('parses scientific notation as a number', () => {
    expect(props('---\nx: 1e3\n---')).toEqual({ x: 1000 });
  });

  it('parses booleans (all YAML casings)', () => {
    expect(props('---\na: true\nb: false\nc: True\nd: FALSE\n---')).toEqual({
      a: true,
      b: false,
      c: true,
      d: false,
    });
  });

  it('keeps an ISO-ish date as a string', () => {
    expect(props('---\ndate: 2026-07-22\n---')).toEqual({ date: '2026-07-22' });
  });

  it('keeps an ISO datetime as a string', () => {
    expect(props('---\nts: 2026-07-22T10:30:00Z\n---')).toEqual({ ts: '2026-07-22T10:30:00Z' });
  });

  it('keeps a number beyond MAX_SAFE_INTEGER as a string', () => {
    const big = '99999999999999999999';
    expect(props(`---\nn: ${big}\n---`)).toEqual({ n: big });
  });

  it('keeps a version-like token as a string', () => {
    expect(props('---\nv: 1.2.3\n---')).toEqual({ v: '1.2.3' });
  });

  it('keeps YAML infinity/NaN tokens as strings', () => {
    expect(props('---\na: .inf\nb: .nan\n---')).toEqual({ a: '.inf', b: '.nan' });
  });

  it('keeps YAML-truthy words (yes/no/on/off) as strings', () => {
    expect(props('---\na: yes\nb: no\nc: on\nd: off\n---')).toEqual({
      a: 'yes',
      b: 'no',
      c: 'on',
      d: 'off',
    });
  });

  it('keeps underscore-grouped and hex numerics as strings', () => {
    expect(props('---\nc: 1_000\nd: 0x10\n---')).toEqual({ c: '1_000', d: '0x10' });
  });

  it('parses leading-dot, trailing-dot, and explicit-plus numerics', () => {
    expect(props('---\na: .5\nb: 5.\nc: +5\n---')).toEqual({ a: 0.5, b: 5, c: 5 });
  });
});

// ============================================================================
// Quoted strings
// ============================================================================

describe('parseFrontmatter — quoted strings', () => {
  it('parses a double-quoted string', () => {
    expect(props('---\ntitle: "Hello: World"\n---')).toEqual({ title: 'Hello: World' });
  });

  it('parses a single-quoted string', () => {
    expect(props("---\ntitle: 'Hello World'\n---")).toEqual({ title: 'Hello World' });
  });

  it('a quoted number stays a string', () => {
    expect(props('---\nn: "42"\n---')).toEqual({ n: '42' });
  });

  it('a quoted boolean stays a string', () => {
    expect(props('---\nb: "true"\n---')).toEqual({ b: 'true' });
  });

  it('decodes double-quote escapes', () => {
    expect(props('---\ns: "line1\\nline2\\t\\"q\\""\n---')).toEqual({ s: 'line1\nline2\t"q"' });
  });

  it('handles single-quote doubling as an escaped quote', () => {
    expect(props("---\ns: 'it''s here'\n---")).toEqual({ s: "it's here" });
  });

  it('keeps an empty quoted string', () => {
    expect(props('---\ns: ""\n---')).toEqual({ s: '' });
  });

  it('does not strip a # inside a quoted string', () => {
    expect(props('---\ns: "a # b"\n---')).toEqual({ s: 'a # b' });
  });

  it('does not split on a colon inside a quoted value', () => {
    expect(props('---\nurl: "http://example.com/x"\n---')).toEqual({ url: 'http://example.com/x' });
  });
});

// ============================================================================
// Lists
// ============================================================================

describe('parseFrontmatter — lists', () => {
  it('parses a flow list of strings', () => {
    expect(props('---\ntags: [a, b, c]\n---')).toEqual({ tags: ['a', 'b', 'c'] });
  });

  it('parses a flow list of numbers', () => {
    expect(props('---\nnums: [1, 2, 3]\n---')).toEqual({ nums: [1, 2, 3] });
  });

  it('parses a flow list with quoted items containing commas', () => {
    expect(props('---\ntags: ["a, b", c]\n---')).toEqual({ tags: ['a, b', 'c'] });
  });

  it('parses an empty flow list', () => {
    expect(props('---\ntags: []\n---')).toEqual({ tags: [] });
  });

  it('parses a block list', () => {
    expect(props('---\ntags:\n  - a\n  - b\n  - c\n---')).toEqual({ tags: ['a', 'b', 'c'] });
  });

  it('parses a block list of numbers', () => {
    expect(props('---\nnums:\n  - 1\n  - 2\n---')).toEqual({ nums: [1, 2] });
  });

  it('parses a block list with quoted items', () => {
    expect(props('---\ntags:\n  - "x: y"\n  - z\n---')).toEqual({ tags: ['x: y', 'z'] });
  });

  it('rejects a block list containing a nested map item (unsupported)', () => {
    const r = parseFrontmatter('---\nitems:\n  - a\n  - k: v\n---');
    expect(r.properties).not.toHaveProperty('items');
    expect(r.diagnostics.some((d) => d.key === 'items' && d.reason === 'unsupported_value')).toBe(
      true,
    );
  });

  it('rejects the whole key when a flow list contains a boolean item', () => {
    const r = parseFrontmatter('---\nt: [true, x]\n---');
    expect(r.properties).not.toHaveProperty('t');
    expect(r.diagnostics.some((d) => d.key === 't' && d.reason === 'unsupported_value')).toBe(true);
  });

  it('keeps a trailing empty item from a trailing-comma flow list', () => {
    // The trailing comma produces an empty final item; pin the current contract.
    expect(props('---\nt: [a, b, ]\n---')).toEqual({ t: ['a', 'b', ''] });
  });
});

// ============================================================================
// Comments
// ============================================================================

describe('parseFrontmatter — comments', () => {
  it('strips a trailing comment', () => {
    expect(props('---\ntitle: Hello # a comment\n---')).toEqual({ title: 'Hello' });
  });

  it('strips a full-line comment', () => {
    expect(props('---\n# just a comment\ntitle: Hello\n---')).toEqual({ title: 'Hello' });
  });

  it('keeps a # that is part of a token (no preceding space)', () => {
    expect(props('---\ncolor: "#fff"\n---')).toEqual({ color: '#fff' });
  });

  it('does not treat a # inside quotes as a comment', () => {
    expect(props('---\ns: "value # not comment"\n---')).toEqual({ s: 'value # not comment' });
  });

  it('drops a key whose entire value is a comment, with no diagnostic', () => {
    const r = parseFrontmatter('---\nk: # only a comment\ntitle: X\n---');
    expect(r.properties).toEqual({ title: 'X' });
    expect(r.diagnostics).toEqual([]);
  });
});

// ============================================================================
// Duplicate keys
// ============================================================================

describe('parseFrontmatter — duplicate keys', () => {
  it('keeps the first value and diagnoses the duplicate', () => {
    const r = parseFrontmatter('---\ntitle: first\ntitle: second\n---');
    expect(r.properties).toEqual({ title: 'first' });
    expect(r.diagnostics.some((d) => d.key === 'title' && /uplicate/.test(d.message))).toBe(true);
  });

  it('a duplicate after an unsupported first value still counts as seen', () => {
    const r = parseFrontmatter('---\nk: &anchor\nk: later\n---');
    expect(r.properties).not.toHaveProperty('k');
    const kDiags = r.diagnostics.filter((d) => d.key === 'k');
    expect(kDiags.length).toBeGreaterThanOrEqual(2);
  });

  it('reports a repeated forbidden key as forbidden on BOTH occurrences', () => {
    const r = parseFrontmatter('---\nconstructor: a\nconstructor: b\n---');
    expect(r.properties).toEqual({});
    const forbidden = r.diagnostics.filter(
      (d) => d.key === 'constructor' && d.reason === 'unsupported_value',
    );
    expect(forbidden.length).toBe(2);
  });
});

// ============================================================================
// Prototype-pollution safety
// ============================================================================

describe('parseFrontmatter — forbidden keys (prototype pollution)', () => {
  it('rejects __proto__', () => {
    const r = parseFrontmatter('---\n__proto__: evil\n---');
    expect(r.properties).not.toHaveProperty('evil');
    expect(Object.keys(r.properties)).not.toContain('__proto__');
    expect(
      r.diagnostics.some((d) => d.key === '__proto__' && d.reason === 'unsupported_value'),
    ).toBe(true);
  });

  it('does not pollute Object.prototype via __proto__', () => {
    parseFrontmatter('---\n__proto__: {"polluted": true}\n---');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects constructor', () => {
    const r = parseFrontmatter('---\nconstructor: x\n---');
    expect(Object.keys(r.properties)).not.toContain('constructor');
    expect(r.diagnostics.some((d) => d.key === 'constructor')).toBe(true);
  });

  it('rejects prototype', () => {
    const r = parseFrontmatter('---\nprototype: x\n---');
    expect(Object.keys(r.properties)).not.toContain('prototype');
    expect(r.diagnostics.some((d) => d.key === 'prototype')).toBe(true);
  });

  it('a quoted __proto__ key is still forbidden', () => {
    const r = parseFrontmatter('---\n"__proto__": evil\n---');
    expect(r.diagnostics.some((d) => d.key === '__proto__')).toBe(true);
    expect(Object.keys(r.properties)).not.toContain('__proto__');
  });

  it('the returned object has a plain prototype', () => {
    const r = parseFrontmatter('---\ntitle: Hello\n---');
    expect(Object.getPrototypeOf(r.properties)).toBe(Object.prototype);
  });
});

// ============================================================================
// Unsupported YAML constructs
// ============================================================================

describe('parseFrontmatter — unsupported constructs', () => {
  it('rejects a YAML anchor', () => {
    const r = parseFrontmatter('---\nk: &anchor value\n---');
    expect(r.properties).not.toHaveProperty('k');
    expect(r.diagnostics.some((d) => d.key === 'k' && d.reason === 'unsupported_value')).toBe(true);
  });

  it('rejects a YAML alias', () => {
    const r = parseFrontmatter('---\nk: *ref\n---');
    expect(r.properties).not.toHaveProperty('k');
    expect(r.diagnostics.some((d) => d.key === 'k' && d.reason === 'unsupported_value')).toBe(true);
  });

  it('rejects a custom tag', () => {
    const r = parseFrontmatter('---\nk: !!binary abcd\n---');
    expect(r.properties).not.toHaveProperty('k');
    expect(r.diagnostics.some((d) => d.key === 'k' && d.reason === 'unsupported_value')).toBe(true);
  });

  it('rejects a merge key', () => {
    const r = parseFrontmatter('---\n<<: *defaults\n---');
    expect(r.properties).not.toHaveProperty('<<');
    expect(r.diagnostics.some((d) => d.reason === 'unsupported_value')).toBe(true);
  });

  it('rejects a literal block scalar', () => {
    const r = parseFrontmatter('---\ntext: |\n  line one\n  line two\n---');
    expect(r.properties).not.toHaveProperty('text');
    expect(r.diagnostics.some((d) => d.key === 'text' && d.reason === 'unsupported_value')).toBe(
      true,
    );
  });

  it('rejects a folded block scalar', () => {
    const r = parseFrontmatter('---\ntext: >\n  folded line\n---');
    expect(r.properties).not.toHaveProperty('text');
    expect(r.diagnostics.some((d) => d.key === 'text' && d.reason === 'unsupported_value')).toBe(
      true,
    );
  });

  it('rejects a nested map', () => {
    const r = parseFrontmatter('---\nmeta:\n  a: 1\n  b: 2\n---');
    expect(r.properties).not.toHaveProperty('meta');
    expect(r.diagnostics.some((d) => d.key === 'meta' && d.reason === 'unsupported_value')).toBe(
      true,
    );
  });

  it('rejects an inline (flow) map value', () => {
    const r = parseFrontmatter('---\nmeta: {a: 1}\n---');
    expect(r.properties).not.toHaveProperty('meta');
    expect(r.diagnostics.some((d) => d.key === 'meta' && d.reason === 'unsupported_value')).toBe(
      true,
    );
  });

  it('rejects a null scalar', () => {
    const r = parseFrontmatter('---\nk: null\n---');
    expect(r.properties).not.toHaveProperty('k');
    expect(r.diagnostics.some((d) => d.key === 'k' && d.reason === 'unsupported_value')).toBe(true);
  });

  it('keeps siblings when one value is unsupported', () => {
    const r = parseFrontmatter('---\ngood: yes-value\nbad: &a x\nalso: 5\n---');
    expect(r.properties).toEqual({ good: 'yes-value', also: 5 });
    expect(r.diagnostics.some((d) => d.key === 'bad')).toBe(true);
  });
});

// ============================================================================
// Oversized frontmatter → absent
// ============================================================================

describe('parseFrontmatter — oversized block', () => {
  it('treats a block that does not close within the scan budget as absent', () => {
    const filler = 'x: ' + 'a'.repeat(20000) + '\n';
    const r = parseFrontmatter('---\n' + filler + 'title: Hello\n---\nbody');
    expect(r.hadFrontmatter).toBe(false);
    expect(r.properties).toEqual({});
  });

  it('parses a block that closes just within the budget', () => {
    const r = parseFrontmatter('---\ntitle: Hello\n---\n' + 'z'.repeat(50000));
    expect(r.hadFrontmatter).toBe(true);
    expect(r.properties).toEqual({ title: 'Hello' });
  });
});

// ============================================================================
// Caps
// ============================================================================

describe('parseFrontmatter — caps', () => {
  it('drops keys beyond MAX_PROPERTY_KEYS with a clamped diagnostic each', () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push(`k${String(i)}: v${String(i)}`);
    const r = parseFrontmatter('---\n' + lines.join('\n') + '\n---');
    expect(Object.keys(r.properties).length).toBe(32);
    const dropped = r.diagnostics.filter((d) => d.reason === 'clamped');
    expect(dropped.length).toBe(8);
    // First 32 keys kept, later ones dropped.
    expect(r.properties).toHaveProperty('k0');
    expect(r.properties).not.toHaveProperty('k39');
  });

  it('truncates an over-long string value and diagnoses clamped', () => {
    const long = 'a'.repeat(600);
    const r = parseFrontmatter(`---\ns: ${long}\n---`);
    expect((r.properties['s'] as string).length).toBe(512);
    expect(r.diagnostics.some((d) => d.key === 's' && d.reason === 'clamped')).toBe(true);
  });

  it('truncates an over-long array and diagnoses clamped', () => {
    const items: string[] = [];
    for (let i = 0; i < 40; i++) items.push(`  - i${String(i)}`);
    const r = parseFrontmatter('---\nlist:\n' + items.join('\n') + '\n---');
    expect((r.properties['list'] as unknown[]).length).toBe(32);
    expect(r.diagnostics.some((d) => d.key === 'list' && d.reason === 'clamped')).toBe(true);
  });

  it('drops keys until under the total-bytes budget', () => {
    const lines: string[] = [];
    // Each value ~500 chars; ~20 keys blows past the 8192-byte budget.
    for (let i = 0; i < 20; i++) lines.push(`k${String(i)}: ${'b'.repeat(500)}`);
    const r = parseFrontmatter('---\n' + lines.join('\n') + '\n---');
    const size = Buffer.byteLength(JSON.stringify(r.properties), 'utf8');
    expect(size).toBeLessThanOrEqual(8192);
    expect(r.diagnostics.some((d) => d.reason === 'clamped')).toBe(true);
    // Earlier keys are kept in preference to later ones.
    expect(r.properties).toHaveProperty('k0');
    expect(r.properties).not.toHaveProperty('k19');
  });
});

// ============================================================================
// Invalid-yaml path
// ============================================================================

describe('parseFrontmatter — invalid yaml', () => {
  it('a bare list at document root is invalid', () => {
    const r = parseFrontmatter('---\n- a\n- b\n---');
    expect(r.hadFrontmatter).toBe(true);
    expect(r.properties).toEqual({});
    expect(r.diagnostics).toEqual([{ reason: 'invalid_yaml', message: expect.any(String) }]);
  });

  it('a line without a key/value separator is invalid', () => {
    const r = parseFrontmatter('---\njust some prose with no colon\n---');
    expect(r.hadFrontmatter).toBe(true);
    expect(r.properties).toEqual({});
    expect(r.diagnostics).toEqual([{ reason: 'invalid_yaml', message: expect.any(String) }]);
  });

  it('unexpected indentation at root is invalid', () => {
    const r = parseFrontmatter('---\n  indented: x\n---');
    expect(r.hadFrontmatter).toBe(true);
    expect(r.properties).toEqual({});
    expect(r.diagnostics.some((d) => d.reason === 'invalid_yaml')).toBe(true);
  });
});

// ============================================================================
// Misc structural
// ============================================================================

describe('parseFrontmatter — structural', () => {
  it('ignores blank lines between pairs', () => {
    expect(props('---\na: 1\n\nb: 2\n---')).toEqual({ a: 1, b: 2 });
  });

  it('drops a key with an empty value silently', () => {
    const r = parseFrontmatter('---\nempty:\ntitle: Hello\n---');
    expect(r.properties).toEqual({ title: 'Hello' });
    expect(r.diagnostics).toEqual([]);
  });

  it('handles a value that contains a colon-space after the first', () => {
    expect(props('---\nnote: see this: thing\n---')).toEqual({ note: 'see this: thing' });
  });
});
