import { describe, it, expect } from 'vitest';
import { isArrivingBatch, MAX_ARRIVING_ITEMS } from './TranscriptEntranceContext.js';

/**
 * Which mounts get an entrance animation.
 *
 * The failure this replaces was silent in exactly the way that matters: the
 * old latch settled a frame after the transcript component mounted, which is
 * before the snapshot it renders has arrived. Every bubble then read "already
 * shown once" and animated anyway — the code looked like it suppressed the
 * cascade and did nothing at all.
 */
describe('isArrivingBatch', () => {
  it('says nothing arrived on the first paint of a conversation', () => {
    // Opening a session mounts its whole page at once. This is history being
    // shown, however many messages it is.
    expect(isArrivingBatch(0, 60)).toBe(false);
    expect(isArrivingBatch(0, 1)).toBe(false);
    expect(isArrivingBatch(0, 208)).toBe(false);
  });

  it('says a message arriving is arriving', () => {
    expect(isArrivingBatch(60, 61)).toBe(true);
  });

  it('allows a turn to land a card or separator beside its message', () => {
    expect(isArrivingBatch(60, 60 + MAX_ARRIVING_ITEMS)).toBe(true);
  });

  it('says a page of older history is not arriving', () => {
    // The reader asked for it and it lands above them. Sixty entrance
    // animations at once was the largest layout-shift cluster on the page.
    expect(isArrivingBatch(60, 121)).toBe(false);
  });

  it('says a deeper re-hydrate is not arriving', () => {
    expect(isArrivingBatch(121, 184)).toBe(false);
  });

  it('stays quiet when nothing changed', () => {
    expect(isArrivingBatch(60, 60)).toBe(false);
  });

  it('stays quiet when the transcript shrinks', () => {
    // A session switch, or a streaming message collapsing into its final form.
    expect(isArrivingBatch(60, 12)).toBe(false);
  });
});
