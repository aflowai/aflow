/**
 * RFC 7233 single-range parsing for byte-serving routes.
 */

/**
 * `none` means serve the whole representation: the header was absent, spoke a
 * unit we do not serve, or was syntactically invalid — all of which an origin
 * server answers with a normal 200. `unsatisfiable` is the distinct case the
 * spec answers with 416: the syntax was fine and the range sits past the end.
 */
export type ParsedByteRange =
  { kind: 'none' } | { kind: 'unsatisfiable' } | { kind: 'range'; start: number; end: number };

const NONE: ParsedByteRange = { kind: 'none' };
const UNSATISFIABLE: ParsedByteRange = { kind: 'unsatisfiable' };

function parseOffset(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Resolve a `Range` header against a known representation size.
 *
 * Multi-range requests parse as `none`: serving them requires a
 * `multipart/byteranges` body, and ignoring a Range is always permitted.
 */
export function parseByteRangeHeader(
  header: string | undefined,
  sizeBytes: number,
): ParsedByteRange {
  if (header === undefined) return NONE;

  const spec = /^bytes=(.+)$/.exec(header.trim());
  if (!spec?.[1]) return NONE;

  const value = spec[1].trim();
  if (value.includes(',')) return NONE;

  const parts = /^(\d*)-(\d*)$/.exec(value);
  if (!parts) return NONE;

  const rawStart = parts[1] ?? '';
  const rawEnd = parts[2] ?? '';

  if (rawStart === '') {
    const suffixLength = parseOffset(rawEnd);
    if (suffixLength === null) return NONE;
    if (suffixLength === 0 || sizeBytes === 0) return UNSATISFIABLE;
    return { kind: 'range', start: Math.max(0, sizeBytes - suffixLength), end: sizeBytes - 1 };
  }

  const start = parseOffset(rawStart);
  if (start === null) return NONE;

  if (rawEnd === '') {
    if (start >= sizeBytes) return UNSATISFIABLE;
    return { kind: 'range', start, end: sizeBytes - 1 };
  }

  const end = parseOffset(rawEnd);
  if (end === null) return NONE;
  if (start > end) return NONE;
  if (start >= sizeBytes) return UNSATISFIABLE;

  return { kind: 'range', start, end: Math.min(end, sizeBytes - 1) };
}
