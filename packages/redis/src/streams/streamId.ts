/**
 * Redis stream ids, parsed and compared strictly.
 *
 * A stream id is `<ms>-<seq>`. Redis also accepts the `<ms>` shorthand on input,
 * where the sequence defaults to 0, and `0` is the conventional "from the
 * beginning" cursor.
 *
 * Strict on purpose. The implementations this replaces both coerced an
 * unparseable id to `{ ms: 0, seq: 0 }`, which sorts before every real entry —
 * so a corrupt cursor compared as "older than everything" and a caller asking
 * for what comes after it would silently replay the whole stream instead of
 * reporting a bad cursor. Failing closed turns that into an error at the one
 * place that can still tell the difference.
 */

export interface ParsedStreamId {
  ms: number;
  seq: number;
}

const STREAM_ID_PATTERN = /^(\d+)(?:-(\d+))?$/;

/** `null` for anything that is not a well-formed entry id. */
export function tryParseStreamId(id: string): ParsedStreamId | null {
  const match = STREAM_ID_PATTERN.exec(id);
  if (!match) return null;
  const ms = Number(match[1]);
  const seq = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(seq)) return null;
  return { ms, seq };
}

export function isValidStreamId(id: string): boolean {
  return tryParseStreamId(id) !== null;
}

/** Throws on a malformed id. Use {@link tryParseStreamId} where input is untrusted. */
export function parseStreamId(id: string): ParsedStreamId {
  const parsed = tryParseStreamId(id);
  if (parsed === null) {
    throw new Error(`malformed Redis stream id: ${JSON.stringify(id)}`);
  }
  return parsed;
}

/** Numeric compare. Lexicographic compare lies: `10-0` sorts before `9-0`. */
export function compareStreamIds(a: string, b: string): number {
  const left = parseStreamId(a);
  const right = parseStreamId(b);
  if (left.ms !== right.ms) return left.ms < right.ms ? -1 : 1;
  if (left.seq !== right.seq) return left.seq < right.seq ? -1 : 1;
  return 0;
}

/**
 * The smallest id strictly greater than `id`, for turning an inclusive range
 * bound into an exclusive one.
 *
 * Redis 6.2+ has native exclusive ranges (`(<id>`); this exists for callers
 * that must pass an inclusive bound, and for computing a trim frontier.
 */
export function nextStreamId(id: string): string {
  const { ms, seq } = parseStreamId(id);
  return `${String(ms)}-${String(seq + 1)}`;
}
