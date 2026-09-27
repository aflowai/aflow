import { createHash } from 'node:crypto';

/**
 * Deterministic, stable-key-ordered serialization of an arbitrary JSON value.
 *
 * An undefined value (possible on a code-defined object, never on a
 * JSON.parse'd doc) is normalised to `null` so serialization stays total and
 * deterministic.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** sha256 hex digest over {@link stableStringify}'s canonical serialization. */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
