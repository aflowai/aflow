/**
 * The one request shape behind the shared recent-sessions query key.
 *
 * The chat's session list and the Workbench's recent conversations resolve to
 * the same key when the Helmsman is the selected flow. TanStack Query
 * deduplicates by key and not by URL, so two requests differing only in `limit`
 * left whichever mounted first deciding what both observers saw — a result that
 * depended on render order rather than on what either asked for.
 *
 * One limit, named once, and carried in the key so the two cannot silently
 * disagree again: a key has to name the data it holds.
 */
export const SESSION_LIST_LIMIT = 10;

/** The shared key for a space's sessions filtered to one agent target. */
export function sessionListKey(
  spaceId: string,
  targetKind: string,
  targetValue: string,
): Array<string | number> {
  return ['space', spaceId, 'sessions', targetKind, targetValue, SESSION_LIST_LIMIT];
}
