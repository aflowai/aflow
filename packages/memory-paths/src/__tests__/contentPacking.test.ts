import { describe, it, expect } from 'vitest';
import { packCompleteLineArray, packCompleteLines, packCompleteItems } from '../contentPacking.js';

describe('packCompleteLines', () => {
  it('returns the whole text when it fits the budget', () => {
    const text = 'a\nb\nc';
    const out = packCompleteLines(text, 100);
    expect(out).toEqual({ content: text, lineCount: 3, truncated: false });
  });

  it('empty text is zero lines, not truncated', () => {
    expect(packCompleteLines('', 100)).toEqual({ content: '', lineCount: 0, truncated: false });
  });

  it('stops at the last complete line that fits', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${String(i)}-${'x'.repeat(20)}`);
    const text = lines.join('\n');
    const budget = 100;
    const out = packCompleteLines(text, budget);
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(budget);
    expect(out.content).toBe(lines.slice(0, out.lineCount).join('\n'));
    // Adding one more line would exceed the budget.
    expect(lines.slice(0, out.lineCount + 1).join('\n').length).toBeGreaterThan(budget);
  });

  it('a first line larger than the budget keeps nothing', () => {
    const out = packCompleteLines('x'.repeat(200) + '\nshort', 100);
    expect(out).toEqual({ content: '', lineCount: 0, truncated: true });
  });

  it('boundary: exact fit keeps everything', () => {
    const text = 'ab\ncd';
    const out = packCompleteLines(text, text.length);
    expect(out).toEqual({ content: text, lineCount: 2, truncated: false });
  });

  it('counts empty lines as lines', () => {
    const text = '\n\n\n';
    const out = packCompleteLines(text, 100);
    expect(out.lineCount).toBe(4);
    expect(out.truncated).toBe(false);
  });
});

describe('packCompleteLineArray', () => {
  it('matches packCompleteLines char accounting over a pre-split array', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${String(i)}-${'y'.repeat(15)}`);
    const budget = 120;
    const fromArray = packCompleteLineArray(lines, budget);
    const fromText = packCompleteLines(lines.join('\n'), budget);
    expect(fromArray).toEqual(fromText);
  });

  it('keeps a single empty line (an honest one-line window)', () => {
    expect(packCompleteLineArray([''], 100)).toEqual({
      content: '',
      lineCount: 1,
      truncated: false,
    });
  });

  it('an empty array keeps nothing and is not truncated', () => {
    expect(packCompleteLineArray([], 100)).toEqual({ content: '', lineCount: 0, truncated: false });
  });
});

describe('packCompleteItems', () => {
  it('keeps all items within a generous budget and emits valid JSON', () => {
    const items = [{ a: 1 }, { b: 2 }, 'three', null];
    const out = packCompleteItems(items, 1000);
    expect(out.count).toBe(4);
    expect(out.truncated).toBe(false);
    expect(JSON.parse(out.json)).toEqual(items);
  });

  it('drops trailing items to fit and the JSON still parses to exactly the kept prefix', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ i, pad: 'x'.repeat(50) }));
    const perItem = JSON.stringify(items[0]).length;
    const budget = perItem * 10;
    const out = packCompleteItems(items, budget);
    expect(out.truncated).toBe(true);
    expect(out.count).toBeGreaterThan(0);
    expect(out.count).toBeLessThan(100);
    expect(out.json.length).toBeLessThanOrEqual(budget);
    const parsed: unknown = JSON.parse(out.json);
    expect(parsed).toEqual(items.slice(0, out.count));
  });

  it('a single item over the budget keeps nothing and reports its size', () => {
    const items = [{ huge: 'x'.repeat(500) }, { small: 1 }];
    const out = packCompleteItems(items, 100);
    expect(out.count).toBe(0);
    expect(out.truncated).toBe(true);
    expect(out.json).toBe('[]');
    expect(out.oversizedItemChars).toBe(JSON.stringify(items[0]).length);
  });

  it('an empty array is an empty valid window', () => {
    const out = packCompleteItems([], 100);
    expect(out).toEqual({ json: '[]', count: 0, truncated: false });
  });

  it('serializes undefined items as null (JSON.stringify contract)', () => {
    const out = packCompleteItems([undefined, 1], 100);
    expect(JSON.parse(out.json)).toEqual([null, 1]);
  });
});
