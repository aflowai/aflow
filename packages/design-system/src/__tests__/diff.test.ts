import { describe, it, expect } from 'vitest';
import { computeLineDiff, diffJson, diffStats, stableJson } from '../data-display/diff.js';

describe('computeLineDiff', () => {
  it('returns all-context for identical input', () => {
    const lines = computeLineDiff('a\nb\nc', 'a\nb\nc');
    expect(lines.every((l) => l.op === 'context')).toBe(true);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0, changed: false });
  });

  it('detects a single changed line as one del + one add', () => {
    const lines = computeLineDiff('a\nb\nc', 'a\nB\nc');
    expect(lines.map((l) => `${l.op}:${l.text}`)).toEqual([
      'context:a',
      'del:b',
      'add:B',
      'context:c',
    ]);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1, changed: true });
  });

  it('tracks before/after line numbers across an insertion', () => {
    const lines = computeLineDiff('a\nc', 'a\nb\nc');
    const added = lines.find((l) => l.op === 'add');
    expect(added).toMatchObject({ text: 'b', afterLine: 2 });
    const lastCtx = lines[lines.length - 1];
    expect(lastCtx).toMatchObject({ op: 'context', text: 'c', beforeLine: 2, afterLine: 3 });
  });

  it('handles empty before (pure addition) and empty after (pure deletion)', () => {
    expect(diffStats(computeLineDiff('', 'x\ny'))).toEqual({ added: 2, removed: 0, changed: true });
    expect(diffStats(computeLineDiff('x\ny', ''))).toEqual({ added: 0, removed: 2, changed: true });
  });
});

describe('diffJson / stableJson', () => {
  it('sorts object keys so key order is not a diff', () => {
    expect(diffStats(diffJson({ a: 1, b: 2 }, { b: 2, a: 1 }))).toEqual({
      added: 0,
      removed: 0,
      changed: false,
    });
  });

  it('surfaces a real value change', () => {
    const lines = diffJson({ maxAttempts: 3 }, { maxAttempts: 5 });
    expect(lines.some((l) => l.op === 'del' && l.text.includes('3'))).toBe(true);
    expect(lines.some((l) => l.op === 'add' && l.text.includes('5'))).toBe(true);
  });

  it('stableJson is deterministic regardless of insertion order', () => {
    expect(stableJson({ b: 1, a: { d: 4, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 4 }, b: 1 }));
  });
});
