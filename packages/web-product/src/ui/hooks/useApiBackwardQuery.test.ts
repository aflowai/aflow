/**
 * The two decisions a backward-paged read makes.
 *
 * Both fail silently if wrong: the wrong page order renders a conversation out
 * of sequence, which reads as corrupted data rather than as a paging bug, and a
 * cursor offered past the end of history presents as a spinner that never
 * resolves rather than as an end.
 */
import { describe, it, expect } from 'vitest';
import { flattenBackwardPages, nextBackwardPageParam, type BackwardPage } from './useApiQuery.js';

type Item = { eventId: string };
const ev = (id: string): Item => ({ eventId: id });
const page = (ids_: string[], extra: Partial<BackwardPage<Item>> = {}): BackwardPage<Item> => ({
  events: ids_.map(ev),
  ...extra,
});
const ids = (items: Item[]): string[] => items.map((i) => i.eventId);

describe('flattenBackwardPages', () => {
  it('puts the oldest page first, because pages arrive newest-first', () => {
    // Page 0 was fetched first and is the NEWEST; page 1 is older than it.
    const pages = [page(['d', 'e']), page(['b', 'c']), page(['a'])];

    expect(ids(flattenBackwardPages(pages))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps each page internally in order', () => {
    // The pages reverse; the events inside them must not.
    expect(ids(flattenBackwardPages([page(['c', 'd']), page(['a', 'b'])]))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('handles the single page every short session has', () => {
    expect(ids(flattenBackwardPages([page(['a', 'b'])]))).toEqual(['a', 'b']);
  });

  it('handles no pages at all', () => {
    expect(flattenBackwardPages<Item>([])).toEqual([]);
  });

  it('does not mutate the pages it was handed', () => {
    // `reverse()` is in-place; reversing the caller's array would scramble the
    // cache entry TanStack keeps, and only on a re-render.
    const pages = [page(['b']), page(['a'])];
    flattenBackwardPages(pages);

    expect(ids(pages[0]?.events ?? [])).toEqual(['b']);
  });
});

describe('nextBackwardPageParam', () => {
  it('offers the cursor while history remains', () => {
    expect(nextBackwardPageParam(page(['a'], { hasOlder: true, olderCursor: 'c1' }))).toBe('c1');
  });

  it('offers nothing once the history is exhausted', () => {
    expect(
      nextBackwardPageParam(page(['a'], { hasOlder: false, olderCursor: 'c1' })),
    ).toBeUndefined();
  });

  it('offers nothing when the server sent no cursor, whatever it claimed', () => {
    expect(nextBackwardPageParam(page(['a'], { hasOlder: true }))).toBeUndefined();
  });

  it('treats a silent server as the end rather than paging forever', () => {
    expect(nextBackwardPageParam(page(['a']))).toBeUndefined();
  });
});

describe('flattenBackwardPages — the unique-key contract', () => {
  it('drops a repeat rather than handing React two children with one key', () => {
    // A duplicate key is not a degraded render; it is an unsupported one, so
    // this holds regardless of whether the pages should have overlapped.
    const pages = [page(['c']), page(['b', 'c']), page(['a', 'b'])];

    expect(ids(flattenBackwardPages(pages))).toEqual(['a', 'b', 'c']);
  });

  it('keeps the OLDEST occurrence, so position is stable as pages load', () => {
    // Keeping the newest would move an event down the list the moment an older
    // page arrived — the conversation would appear to reorder itself.
    const pages = [page(['b']), page(['a', 'b'])];

    expect(ids(flattenBackwardPages(pages))).toEqual(['a', 'b']);
  });
});
