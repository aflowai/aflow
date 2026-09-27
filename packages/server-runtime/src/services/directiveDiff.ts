/**
 * Compute the sorted, deduped list of top-level keys that differ between
 * `prev` and `next`.
 *
 * - Keys present in `next` but absent in `prev` → reported.
 * - Keys present in `prev` but absent in `next` → reported (deletion).
 * - Keys present in both whose `JSON.stringify` differs → reported.
 * - When `prev` is `null` (first activation), every key in `next` is reported.
 */
export function diffDirectiveKeys(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
): string[] {
  if (prev === null) return Object.keys(next).sort();

  const changed = new Set<string>();
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);

  for (const key of allKeys) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      changed.add(key);
    }
  }

  return [...changed].sort();
}
