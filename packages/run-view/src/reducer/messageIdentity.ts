import type { Message } from '../types.js';

/**
 * Structural equality for the JSON-shaped values a message carries. A key
 * whose value is `undefined` counts as absent, as it would after a JSON round
 * trip.
 */
export function sameMessageValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => sameMessageValue(value, b[i]));
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => sameMessageValue(left[key], right[key]));
}

/**
 * The snapshot's messages, reusing the object already held for every message
 * the snapshot carries unchanged.
 *
 * Reading further back re-folds the whole conversation on the server, so each
 * message in the response is a new object even where nothing about it
 * changed. The transcript memoizes each bubble on its message's identity, so
 * keeping that identity is what stops a page of older history from
 * re-rendering, and re-parsing the markdown of, every message already shown.
 * The previous array itself is returned when nothing was added, removed or
 * changed.
 */
export function reuseUnchangedMessages(previous: Message[], next: Message[]): Message[] {
  if (previous.length === 0) return next;
  const held = new Map<string, Message>();
  for (const message of previous) held.set(message.id, message);
  const merged = next.map((message) => {
    const prior = held.get(message.id);
    return prior !== undefined && sameMessageValue(prior, message) ? prior : message;
  });
  const unchanged =
    merged.length === previous.length && merged.every((message, i) => message === previous[i]);
  return unchanged ? previous : merged;
}
