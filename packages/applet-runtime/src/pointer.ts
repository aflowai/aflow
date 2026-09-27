/**
 * RFC 6901 primitives shared by patch bounding, template materialization and
 * projection. Interpolated path segments are escaped here — input can never
 * forge pointer structure.
 */
import { JSON_POINTER_RE } from '@aflow/schemas';
import { AppletPointerError } from './errors.js';
import { isJsonRecord } from './json.js';

const CANONICAL_ARRAY_INDEX_RE = /^(0|[1-9][0-9]*)$/;

export function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function unescapeJsonPointerSegment(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** '' is the whole document; otherwise one unescaped segment per '/'-token. */
export function splitJsonPointer(pointer: string): string[] {
  if (!JSON_POINTER_RE.test(pointer)) {
    throw new AppletPointerError(
      'malformed_pointer',
      `'${pointer}' is not an RFC 6901 JSON Pointer`,
      pointer,
    );
  }
  if (pointer === '') return [];
  return pointer.slice(1).split('/').map(unescapeJsonPointerSegment);
}

export interface JsonPointerResolution {
  found: boolean;
  value?: unknown;
}

/**
 * Read the value at `pointer` in `doc`. `found: false` covers missing
 * properties, out-of-range or non-canonical array indices, traversal through
 * scalars, and properties holding `undefined` — a resolution that succeeds
 * always carries a JSON-representable value.
 */
export function resolveJsonPointer(doc: unknown, pointer: string): JsonPointerResolution {
  const segments = splitJsonPointer(pointer);
  let current: unknown = doc;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!CANONICAL_ARRAY_INDEX_RE.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (isJsonRecord(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
      current = current[segment];
    } else {
      return { found: false };
    }
  }
  if (current === undefined) return { found: false };
  return { found: true, value: current };
}
