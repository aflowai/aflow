import { describe, it, expect } from 'vitest';
import {
  formatBadgeCount,
  indicatorToneColor,
  indicatorShouldAnnounceCount,
  type IndicatorTone,
} from '../IndicatorButton.js';

describe('formatBadgeCount', () => {
  it('hides the badge when count is undefined', () => {
    expect(formatBadgeCount(undefined)).toBeNull();
  });

  it('hides the badge when count is zero', () => {
    expect(formatBadgeCount(0)).toBeNull();
  });

  it('hides the badge when count is negative', () => {
    expect(formatBadgeCount(-3)).toBeNull();
  });

  it('hides the badge when count is NaN / Infinity', () => {
    expect(formatBadgeCount(Number.NaN)).toBeNull();
    expect(formatBadgeCount(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('renders an integer count as a string', () => {
    expect(formatBadgeCount(1)).toBe('1');
    expect(formatBadgeCount(7)).toBe('7');
    expect(formatBadgeCount(99)).toBe('99');
  });

  it('floors fractional counts (defensive — should not happen in practice)', () => {
    expect(formatBadgeCount(1.7)).toBe('1');
  });

  it('caps at 99+ so the badge stays single-line', () => {
    expect(formatBadgeCount(100)).toBe('99+');
    expect(formatBadgeCount(2500)).toBe('99+');
  });
});

describe('indicatorToneColor', () => {
  const tones: IndicatorTone[] = ['idle', 'info', 'warning', 'danger'];

  for (const tone of tones) {
    it(`resolves a non-empty color string for tone="${tone}"`, () => {
      const color = indicatorToneColor(tone);
      expect(typeof color).toBe('string');
      expect(color.length).toBeGreaterThan(0);
      // Sanity — token references include a fallback so the indicator
      // never renders as currentColor by accident.
      expect(color).toMatch(/var\(--/);
    });
  }

  it('returns distinct colors per tone (no accidental aliasing)', () => {
    const colors = new Set(tones.map(indicatorToneColor));
    expect(colors.size).toBe(tones.length);
  });
});

describe('indicatorShouldAnnounceCount', () => {
  it('returns true exactly when a badge would render', () => {
    expect(indicatorShouldAnnounceCount(undefined)).toBe(false);
    expect(indicatorShouldAnnounceCount(0)).toBe(false);
    expect(indicatorShouldAnnounceCount(-1)).toBe(false);
    expect(indicatorShouldAnnounceCount(1)).toBe(true);
    expect(indicatorShouldAnnounceCount(99)).toBe(true);
    expect(indicatorShouldAnnounceCount(100)).toBe(true);
  });
});
