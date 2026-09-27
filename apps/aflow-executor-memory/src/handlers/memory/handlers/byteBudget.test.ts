import { describe, it, expect } from 'vitest';
import { applyByteBudget } from './byteBudget.js';

/** Serialized byte size of a single item. */
function size(item: unknown): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

/** Serialized byte size of the whole page as the caller sends it (an array). */
function arraySize(items: unknown[]): number {
  return Buffer.byteLength(JSON.stringify(items), 'utf8');
}

describe('applyByteBudget', () => {
  it('empty input keeps nothing and is not truncated', () => {
    const out = applyByteBudget<number>([], 1024);
    expect(out.items).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it('a single item over budget is kept (progress guarantee) but marked truncated=false', () => {
    const item = { big: 'x'.repeat(200) };
    expect(size(item)).toBeGreaterThan(10);
    const out = applyByteBudget([item], 10);
    expect(out.items).toEqual([item]);
    // Only one item existed and it was kept — nothing was dropped.
    expect(out.truncated).toBe(false);
  });

  it('the first item is always kept even when it alone exceeds the budget, dropping the rest', () => {
    const first = { big: 'x'.repeat(200) };
    const second = { s: 'y' };
    const out = applyByteBudget([first, second], 10);
    expect(out.items).toEqual([first]);
    expect(out.truncated).toBe(true);
  });

  it('byte-exact boundary: the serialized array == budget keeps all', () => {
    const a = { a: 1 };
    const b = { b: 2 };
    const budget = arraySize([a, b]);
    const out = applyByteBudget([a, b], budget);
    expect(out.items).toEqual([a, b]);
    expect(out.truncated).toBe(false);
    expect(arraySize(out.items)).toBeLessThanOrEqual(budget);
  });

  it('one byte under the serialized-array size drops the last item', () => {
    const a = { a: 1 };
    const b = { b: 2 };
    const budget = arraySize([a, b]) - 1;
    const out = applyByteBudget([a, b], budget);
    expect(out.items).toEqual([a]);
    expect(out.truncated).toBe(true);
    expect(arraySize(out.items)).toBeLessThanOrEqual(budget);
  });

  it('budget accounts for array framing (brackets + commas), not just the item sum', () => {
    // Ten identical items whose per-item sum exactly equals the budget: the
    // brackets and commas push the serialized array over, so not all fit.
    const items = Array.from({ length: 10 }, (_, i) => ({ i }));
    const per = size(items[0]);
    const budget = per * 10;
    const out = applyByteBudget(items, budget);
    expect(out.items.length).toBeLessThan(10);
    expect(out.truncated).toBe(true);
    // The load-bearing guarantee: the serialized page never exceeds the budget.
    expect(arraySize(out.items)).toBeLessThanOrEqual(budget);
  });

  it('many small items: keeps the prefix whose serialized array fits and drops the tail', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ i }));
    const per = size(items[0]);
    const budget = per * 10 + 100;
    const out = applyByteBudget(items, budget);
    expect(out.truncated).toBe(true);
    expect(out.items).toEqual(items.slice(0, out.items.length));
    expect(arraySize(out.items)).toBeLessThanOrEqual(budget);
  });

  it('all items fit within a generous budget', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ i }));
    const out = applyByteBudget(items, 1024);
    expect(out.items).toEqual(items);
    expect(out.truncated).toBe(false);
    expect(arraySize(out.items)).toBeLessThanOrEqual(1024);
  });
});
