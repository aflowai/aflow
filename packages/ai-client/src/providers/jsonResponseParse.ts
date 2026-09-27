/**
 * Tolerant JSON parser for provider `generateJson` responses.
 *
 * Even with structured outputs / `responseSchema`, providers occasionally append
 * trailing whitespace, code fences, or a stray second JSON block to a valid JSON
 * object. A naive `JSON.parse` then throws
 *   "Unexpected non-whitespace character after JSON at position N (line 2 column 1)"
 * which surfaces to the user as an opaque "Service Unavailable" error.
 *
 * This helper performs a small, deterministic recovery pass:
 *   1. Trim and strip a single ```json fenced block if present.
 *   2. Try `JSON.parse` on the whole content.
 *   3. If it fails with "after JSON at position N", slice up to N and re-parse.
 *   4. As a last resort, scan for the first top-level balanced object/array and
 *      parse that prefix.
 *
 * Returns `{ parsed, repaired }`. `repaired === true` means we recovered from a
 * malformed response and the caller should log a warning.
 */
export interface ParsedJsonResponse<T = unknown> {
  parsed: T;
  repaired: boolean;
  repairReason?: 'trailing_content' | 'code_fence' | 'balanced_prefix' | 'leading_prose';
}

const FENCE_RE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i;

function stripCodeFence(content: string): { content: string; stripped: boolean } {
  const trimmed = content.trim();
  const m = FENCE_RE.exec(trimmed);
  if (m?.[1] !== undefined) {
    return { content: m[1].trim(), stripped: true };
  }
  return { content: trimmed, stripped: false };
}

/**
 * Extract the byte offset reported by V8/JSC for "after JSON" errors.
 * V8: "Unexpected non-whitespace character after JSON at position 706 (line 2 column 1)"
 * JSC: "Unexpected token X in JSON at position 706"
 */
function extractTrailingPosition(message: string): number | undefined {
  const m = /at position (\d+)/.exec(message);
  if (!m?.[1]) return undefined;
  const pos = Number.parseInt(m[1], 10);
  return Number.isFinite(pos) ? pos : undefined;
}

/**
 * Walk `content` from `start` (which must be `{` or `[`) and return the end
 * index (exclusive) of the matching balanced value, ignoring quoted strings
 * and escape sequences. Returns undefined when the value never closes.
 */
function findBalancedEnd(content: string, start: number): number | undefined {
  const opener = content[start];
  if (opener !== '{' && opener !== '[') return undefined;
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

/**
 * Locate the first JSON value (object or array) in `content`, even when the
 * model has prefaced it with prose ("Perfect! Here's the decision: { ... }").
 * Tries each `{` / `[` candidate in order and returns the first slice that
 * round-trips through `JSON.parse`. Returns undefined when no candidate works.
 */
function locateEmbeddedJson(content: string): { start: number; end: number } | undefined {
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = findBalancedEnd(content, i);
    if (end === undefined) continue;
    try {
      JSON.parse(content.slice(i, end));
      return { start: i, end };
    } catch {
      // Try the next candidate position.
    }
  }
  return undefined;
}

export function parseJsonResponse<T = unknown>(rawContent: string): ParsedJsonResponse<T> {
  const fence = stripCodeFence(rawContent);
  const candidate = fence.content;

  try {
    return {
      parsed: JSON.parse(candidate) as T,
      repaired: fence.stripped,
      ...(fence.stripped ? { repairReason: 'code_fence' as const } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    const trailingPos = extractTrailingPosition(message);
    if (trailingPos !== undefined && trailingPos > 0 && trailingPos <= candidate.length) {
      try {
        return {
          parsed: JSON.parse(candidate.slice(0, trailingPos)) as T,
          repaired: true,
          repairReason: 'trailing_content',
        };
      } catch {
        // fall through to balanced-prefix attempt
      }
    }

    const located = locateEmbeddedJson(candidate);
    if (located !== undefined) {
      const slice = candidate.slice(located.start, located.end);
      // locateEmbeddedJson already verified slice parses; re-parse for the result.
      return {
        parsed: JSON.parse(slice) as T,
        repaired: true,
        repairReason: located.start === 0 ? 'balanced_prefix' : 'leading_prose',
      };
    }

    throw err;
  }
}
