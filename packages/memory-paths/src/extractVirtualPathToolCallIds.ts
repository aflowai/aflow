/**
 * Regex matching /run/outputs/<toolCallId> where toolCallId is any non-slash,
 * non-whitespace, non-quote sequence (UUIDs, compact IDs, etc.).
 */
const VIRTUAL_PATH_RE = /\/run\/outputs\/([^\s/'"]+)/g;

/**
 * Deep-scan a JSON value for embedded /run/outputs/<toolCallId>/... strings
 * and return the set of unique toolCallIds found.
 */
export function extractVirtualPathToolCallIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  scan(value, ids);
  return ids;
}

function scan(value: unknown, ids: Set<string>): void {
  if (typeof value === 'string') {
    VIRTUAL_PATH_RE.lastIndex = 0;
    let match;
    while ((match = VIRTUAL_PATH_RE.exec(value)) !== null) {
      ids.add(match[1]!);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) scan(item, ids);
  } else if (value != null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      scan(v, ids);
    }
  }
}
