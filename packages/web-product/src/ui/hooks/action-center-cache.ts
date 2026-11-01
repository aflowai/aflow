// React-free, so tests drive the cache rules through a bare QueryClient.
import { replaceEqualDeep } from '@tanstack/react-query';
import { ACTION_CENTER_LIST_LIMIT } from '@aflow/schemas';
import type { ActionCenterItem } from './use-action-center-types.js';

/*
 * The stream's snapshot holds what each Action Center source lists. Each
 * source caps its own read, so a source can still cut its share. The route's
 * limit does not cut the snapshot, as it can cut a REST read. "Whole" below
 * means only that: no cut at the route's limit.
 */

export interface ItemsPayload {
  items?: ActionCenterItem[];
  /**
   * The stream whose snapshot made the list whole, as `currentStream` in the
   * broker numbers it. Absent where the newest read was a REST read the route
   * may have cut.
   */
  wholeOn?: number;
}

export function isWhole(payload: ItemsPayload | undefined): boolean {
  return payload?.wholeOn !== undefined;
}

/** The snapshot's write. The route's limit has not cut it, so the list is whole. */
export function snapshotPayload(items: ActionCenterItem[], stream: number | null): ItemsPayload {
  return stream === null ? { items } : { items, wholeOn: stream };
}

/** The cached payload with its items replaced, keeping where the list came from. */
export function withItems(prev: ItemsPayload | undefined, items: ActionCenterItem[]): ItemsPayload {
  return prev?.wholeOn === undefined ? { items } : { items, wholeOn: prev.wholeOn };
}

/**
 * A write without the flag over a whole list, such as a REST refetch. The
 * stream that sent the snapshot has delivered every change since, so while it
 * is still the stream in use the list stays whole. Otherwise the refetch is
 * the newest read and replaces the flag. That covers a stream that is down,
 * and a reconnected stream whose new snapshot has not yet landed. The flag also
 * drops where the write holds the route's limit and fewer items than the whole
 * list held, which says the route cut it.
 */
export function keepWhole(
  prev: ItemsPayload | undefined,
  next: ItemsPayload,
  stream: number | null,
): ItemsPayload {
  if (next.wholeOn !== undefined || prev?.wholeOn === undefined || prev.wholeOn !== stream) {
    return next;
  }
  const nextLength = next.items?.length ?? 0;
  const prevLength = prev.items?.length ?? 0;
  const knownCut = nextLength >= ACTION_CENTER_LIST_LIMIT && nextLength < prevLength;
  return knownCut ? next : { ...next, wholeOn: prev.wholeOn };
}

/**
 * The query's `structuralSharing`. TanStack runs it on every write to the key,
 * a fetch's result and `setQueryData` alike, so no write drops the flag past
 * `keepWhole`.
 */
export function itemsStructuralSharing(
  currentStream: () => number | null,
): (prev: unknown, next: unknown) => unknown {
  return (prev, next) =>
    replaceEqualDeep(
      prev,
      keepWhole(prev as ItemsPayload | undefined, next as ItemsPayload, currentStream()),
    );
}
