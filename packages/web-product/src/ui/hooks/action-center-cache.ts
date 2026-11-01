// React-free, so tests drive the cache rules through a bare QueryClient.
import { replaceEqualDeep } from '@tanstack/react-query';
import { ACTION_CENTER_LIST_LIMIT } from '@aflow/schemas';
import type { ActionCenterItem } from './use-action-center-types.js';

export interface ItemsPayload {
  items?: ActionCenterItem[];
  /**
   * True where the list holds every open item: the stream's snapshot set it,
   * and the stream has stayed up since. The REST list may be cut at the
   * route's limit, so on its own it never counts as whole.
   */
  whole?: boolean;
}

/** The snapshot's write: every open item, so the list is whole. */
export function snapshotPayload(items: ActionCenterItem[]): ItemsPayload {
  return { items, whole: true };
}

/** The cached payload with its items replaced, keeping where the list came from. */
export function withItems(prev: ItemsPayload | undefined, items: ActionCenterItem[]): ItemsPayload {
  return prev?.whole === true ? { items, whole: true } : { items };
}

/**
 * A write without the flag over a whole list, such as a REST refetch. While
 * the stream is up it has delivered every change since the snapshot, so the
 * list stays whole. It stops being whole when the stream is down. It also
 * stops when the write holds the route's limit and fewer items than the whole
 * list held, which says the route cut it.
 */
export function keepWhole(
  prev: ItemsPayload | undefined,
  next: ItemsPayload,
  streamConnected: boolean,
): ItemsPayload {
  if (next.whole !== undefined || prev?.whole !== true || !streamConnected) return next;
  const nextLength = next.items?.length ?? 0;
  const prevLength = prev.items?.length ?? 0;
  const knownCut = nextLength >= ACTION_CENTER_LIST_LIMIT && nextLength < prevLength;
  return knownCut ? next : { ...next, whole: true };
}

/**
 * The query's `structuralSharing`. TanStack runs it on every write to the key,
 * a fetch's result and `setQueryData` alike, so no write drops the flag past
 * `keepWhole`.
 */
export function itemsStructuralSharing(
  streamConnected: () => boolean,
): (prev: unknown, next: unknown) => unknown {
  return (prev, next) =>
    replaceEqualDeep(
      prev,
      keepWhole(prev as ItemsPayload | undefined, next as ItemsPayload, streamConnected()),
    );
}
