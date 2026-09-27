/** One parsed step of an output path. */
export type OutputPathSegment = { kind: 'key'; key: string } | { kind: 'index'; index: number };

const INDEXER_PATTERN = /\[(\d+)\]/g;
const SEGMENT_PATTERN = /^([^.[\]]*)((?:\[\d+\])*)$/;

export function parseOutputPath(path: string): OutputPathSegment[] | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  const out: OutputPathSegment[] = [];
  for (const rawSegment of path.split('.')) {
    const match = SEGMENT_PATTERN.exec(rawSegment);
    if (!match) return null;
    const key = match[1] ?? '';
    const indexers = match[2] ?? '';
    if (key.length === 0 && indexers.length === 0) return null; // empty segment ('a..b', leading/trailing dot)
    if (key.length > 0) out.push({ kind: 'key', key });
    if (indexers.length > 0) {
      INDEXER_PATTERN.lastIndex = 0;
      let idxMatch: RegExpExecArray | null;
      while ((idxMatch = INDEXER_PATTERN.exec(indexers)) !== null) {
        out.push({ kind: 'index', index: Number(idxMatch[1]) });
      }
    }
  }
  return out;
}

/** Walk pre-parsed segments. `undefined` = missing at any step. */
export function readParsedOutputPath(value: unknown, segments: OutputPathSegment[]): unknown {
  let cursor: unknown = value;
  for (const segment of segments) {
    if (segment.kind === 'key') {
      if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
      cursor = (cursor as Record<string, unknown>)[segment.key];
    } else {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[segment.index];
    }
  }
  return cursor;
}

/**
 * Read `path` from `value` under the shared dialect. An unparseable path
 * reads as missing (`undefined`) — write-time validation is the loud gate.
 */
export function readOutputPath(value: unknown, path: string): unknown {
  const segments = parseOutputPath(path);
  if (!segments) return undefined;
  return readParsedOutputPath(value, segments);
}
