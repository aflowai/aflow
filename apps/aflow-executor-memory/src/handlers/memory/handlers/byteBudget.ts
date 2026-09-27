/** Default from MemoryBudgetSchema.maxTotalBytes when the caller omits a budget. */
export const DEFAULT_MAX_TOTAL_BYTES = 32768;

/** Bytes `JSON.stringify` adds around the items themselves: the two brackets. */
const ARRAY_BRACKETS_BYTES = 2;

/**
 * Trim a result page to a serialized byte budget, deterministically.
 *
 * The budget bounds the serialized *array* — `Buffer.byteLength(JSON.stringify
 * (kept), 'utf8')` — not just the sum of per-item sizes, so the running total
 * seeds the two `[]` brackets and charges one comma for each item after the
 * first. Items are kept in order while that total stays within `maxTotalBytes`;
 * the first item that would exceed it and everything after are dropped, and
 * `truncated` reports whether any item was dropped.
 */
export function applyByteBudget<T>(
  items: T[],
  maxTotalBytes: number,
): { items: T[]; truncated: boolean } {
  const kept: T[] = [];
  let total = ARRAY_BRACKETS_BYTES;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8');
    const separator = kept.length > 0 ? 1 : 0;
    // Always keep the first item even when it alone exceeds the budget, so a
    // page is never empty and keyset pagination can still advance past it.
    if (kept.length > 0 && total + separator + size > maxTotalBytes) {
      return { items: kept, truncated: true };
    }
    kept.push(item);
    total += separator + size;
  }
  return { items: kept, truncated: items.length > kept.length };
}
