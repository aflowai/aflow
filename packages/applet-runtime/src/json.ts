export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `value` nests containers deeper than `maxDepth` (scalars are depth
 * 0, `[]`/`{}` depth 1). Bounded recursion — a cyclic structure reports as
 * exceeding rather than overflowing the stack.
 */
export function exceedsJsonDepth(value: unknown, maxDepth: number): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (maxDepth <= 0) return true;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => exceedsJsonDepth(child, maxDepth - 1));
}

/**
 * Deterministic serialization for payload equality — object keys sorted at
 * every level, so a jsonb round-trip (Postgres reorders keys) still compares
 * equal to the original.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isJsonRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

export function jsonUtf8Bytes(value: unknown): number {
  // JSON.stringify yields undefined for undefined/function/symbol inputs; its
  // lib type says string, so narrow through the honest union explicitly.
  const serialized = JSON.stringify(value) as string | undefined;
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
}
