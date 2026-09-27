import { describe, it, expect } from 'vitest';
import { nextReservedHeight } from './mount-when-near.js';

/**
 * What a card's placeholder holds while the card itself is unmounted.
 *
 * The failure is one-directional and quiet: reserve too little and the
 * transcript collapses under the reader the moment a card scrolls out of
 * range, which reads as the page losing its place rather than as a card
 * unmounting.
 */
describe('nextReservedHeight', () => {
  it('takes the first real measurement', () => {
    expect(nextReservedHeight(null, 320)).toBe(320);
  });

  it('grows to the taller measurement', () => {
    // The document inside reported back and the card got bigger.
    expect(nextReservedHeight(320, 540)).toBe(540);
  });

  it('does not shrink to a height the card is about to leave', () => {
    // An iframe caught at its minimum, mid-mount, before its content reports.
    expect(nextReservedHeight(540, 320)).toBe(540);
  });

  it('ignores a collapsed measurement entirely', () => {
    // Unmounting, or hidden behind a closed disclosure.
    expect(nextReservedHeight(540, 0)).toBe(540);
    expect(nextReservedHeight(null, 0)).toBe(null);
  });

  it('ignores a measurement that is not a usable number', () => {
    expect(nextReservedHeight(540, Number.NaN)).toBe(540);
    expect(nextReservedHeight(540, Number.POSITIVE_INFINITY)).toBe(540);
  });
});
