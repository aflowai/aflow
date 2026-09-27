import { describe, it, expect } from 'vitest';
import { buildOutline, parseDottedPath, selectJsonPath, windowArray } from '../structural.js';

// A ledger-shaped fixture (workflow + rolling run-summary entries).
const ledger = {
  workflow: { slug: 'kaggle', name: 'Kaggle Optimizer' },
  ledgerSummary: {
    totalRuns: 22,
    recentEntries: Array.from({ length: 22 }, (_, i) => ({
      runId: `run-${String(i)}`,
      status: i % 2 === 0 ? 'completed' : 'failed',
      score: i,
    })),
  },
};

describe('buildOutline', () => {
  it('reports type, length, and bytes for the root object', () => {
    const outline = buildOutline(ledger);
    expect(outline.type).toBe('object');
    expect(outline.length).toBe(2); // workflow, ledgerSummary
    expect(outline.bytes).toBe(Buffer.byteLength(JSON.stringify(ledger), 'utf-8'));
    expect(outline.key).toBeUndefined(); // root has no key
  });

  it('expands children with keys and sizes so the agent knows where to drill', () => {
    const outline = buildOutline(ledger, { maxDepth: 2 });
    const summary = outline.children?.find((c) => c.key === 'ledgerSummary');
    expect(summary).toBeDefined();
    expect(summary?.type).toBe('object');
    const entries = summary?.children?.find((c) => c.key === 'recentEntries');
    expect(entries?.type).toBe('array');
    expect(entries?.length).toBe(22);
  });

  it('stops expanding at the depth budget and flags truncatedChildren', () => {
    const outline = buildOutline(ledger, { maxDepth: 1 });
    const summary = outline.children?.find((c) => c.key === 'ledgerSummary');
    // depth budget exhausted one level down → no grandchildren, flagged
    expect(summary?.children).toBeUndefined();
    expect(summary?.truncatedChildren).toBe(true);
  });

  it('caps breadth with maxChildren and flags truncatedChildren', () => {
    const outline = buildOutline(ledger.ledgerSummary.recentEntries, { maxChildren: 5 });
    expect(outline.type).toBe('array');
    expect(outline.length).toBe(22);
    expect(outline.children).toHaveLength(5);
    expect(outline.truncatedChildren).toBe(true);
  });

  it('records string character length, not bytes', () => {
    const outline = buildOutline({ note: 'héllo' });
    const note = outline.children?.find((c) => c.key === 'note');
    expect(note?.type).toBe('string');
    expect(note?.length).toBe(5); // 5 chars even though é is 2 bytes
  });

  it('classifies scalars and null', () => {
    const outline = buildOutline({ a: 1, b: true, c: null });
    const types = Object.fromEntries((outline.children ?? []).map((c) => [c.key, c.type] as const));
    expect(types).toEqual({ a: 'number', b: 'boolean', c: 'null' });
  });
});

describe('parseDottedPath', () => {
  it('parses dotted keys and bracket indices', () => {
    expect(parseDottedPath('a.b[3].c')).toEqual(['a', 'b', 3, 'c']);
  });

  it('treats a leading $ as the root marker', () => {
    expect(parseDottedPath('$.ledgerSummary.recentEntries')).toEqual([
      'ledgerSummary',
      'recentEntries',
    ]);
  });

  it('supports bracket-quoted keys with special chars', () => {
    expect(parseDottedPath('a["weird.key"][0]')).toEqual(['a', 'weird.key', 0]);
  });

  it('throws on an unclosed bracket', () => {
    expect(() => parseDottedPath('a[3')).toThrow(/Unclosed/);
  });

  it('throws on a non-integer index', () => {
    expect(() => parseDottedPath('a[foo]')).toThrow(/Invalid array index/);
  });
});

describe('selectJsonPath', () => {
  it('returns the root for an empty path', () => {
    expect(selectJsonPath(ledger, '')).toEqual({ found: true, value: ledger });
    expect(selectJsonPath(ledger, '$')).toEqual({ found: true, value: ledger });
  });

  it('drills to a nested subtree', () => {
    const res = selectJsonPath(ledger, 'ledgerSummary.recentEntries');
    expect(res.found).toBe(true);
    expect(Array.isArray(res.value)).toBe(true);
    expect((res.value as unknown[]).length).toBe(22);
  });

  it('drills through array indices (bracket and dotted forms agree)', () => {
    const bracket = selectJsonPath(ledger, 'ledgerSummary.recentEntries[12].runId');
    const dotted = selectJsonPath(ledger, 'ledgerSummary.recentEntries.12.runId');
    expect(bracket).toEqual({ found: true, value: 'run-12' });
    expect(dotted).toEqual(bracket);
  });

  it('reports not-found for a missing key', () => {
    expect(selectJsonPath(ledger, 'ledgerSummary.missing')).toEqual({
      found: false,
      value: undefined,
    });
  });

  it('reports not-found when indexing a non-array', () => {
    expect(selectJsonPath(ledger, 'workflow[0]')).toEqual({ found: false, value: undefined });
  });

  it('reports not-found for an out-of-range index', () => {
    expect(selectJsonPath(ledger, 'ledgerSummary.recentEntries[99]')).toEqual({
      found: false,
      value: undefined,
    });
  });

  it('does not resolve inherited prototype members (own-property only)', () => {
    // 'constructor'/'toString'/'__proto__' exist on Object.prototype but are
    // not document fields — selecting one must be not-found, never a function.
    for (const proto of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(selectJsonPath(ledger, proto)).toEqual({ found: false, value: undefined });
      expect(selectJsonPath(ledger, `workflow.${proto}`)).toEqual({
        found: false,
        value: undefined,
      });
    }
  });

  it('still resolves an own key that shadows a prototype name', () => {
    const doc = { constructor: 'a real value', toString: 42 };
    expect(selectJsonPath(doc, 'constructor')).toEqual({ found: true, value: 'a real value' });
    expect(selectJsonPath(doc, 'toString')).toEqual({ found: true, value: 42 });
  });
});

describe('windowArray', () => {
  const entries = ledger.ledgerSummary.recentEntries;

  it('returns the requested window with hasMore=true when more remain', () => {
    const res = windowArray(entries, 10, 5);
    expect(res.items).toHaveLength(5);
    expect(res.totalItems).toBe(22);
    expect(res.hasMore).toBe(true);
    expect((res.items[0] as { runId: string }).runId).toBe('run-10');
  });

  it('sets hasMore=false on the final window', () => {
    const res = windowArray(entries, 20, 5);
    expect(res.items).toHaveLength(2);
    expect(res.hasMore).toBe(false);
  });

  it('returns an empty window past the end', () => {
    const res = windowArray(entries, 100, 5);
    expect(res.items).toHaveLength(0);
    expect(res.hasMore).toBe(false);
  });
});
