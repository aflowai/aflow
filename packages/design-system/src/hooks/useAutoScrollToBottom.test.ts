import { describe, it, expect } from 'vitest';
import { anchoredScrollTop } from './useAutoScrollToBottom.js';

/**
 * Where the reader lands after history is inserted above them.
 *
 * The whole failure this guards is silent: anchoring on `scrollTop` also
 * "works" — the number is preserved exactly — while the message it points at
 * changes, so every page loaded throws the reader a page further back. Only
 * distance from the bottom names the same view before and after.
 */
describe('anchoredScrollTop', () => {
  it('keeps the same distance from the bottom when the list grows upward', () => {
    // 400px above the fold before; the same 400px above it after 1,000px of
    // older history arrives.
    expect(anchoredScrollTop(3000, 400)).toBe(2600);
    expect(anchoredScrollTop(4000, 400)).toBe(3600);
  });

  it('holds a reader at the very bottom at the bottom', () => {
    // distanceFromBottom === clientHeight for someone scrolled fully down.
    expect(anchoredScrollTop(2000, 800)).toBe(1200);
    expect(anchoredScrollTop(5000, 800)).toBe(4200);
  });

  it('does not scroll above the top of the list', () => {
    // A shrink between capture and restore would otherwise produce a negative
    // scrollTop, which browsers clamp — but silently, and to a different place
    // than intended.
    expect(anchoredScrollTop(500, 900)).toBe(0);
  });

  it('is stable when nothing changed', () => {
    expect(anchoredScrollTop(3000, 400)).toBe(anchoredScrollTop(3000, 400));
  });
});
