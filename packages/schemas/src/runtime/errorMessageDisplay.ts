/**
 * Best-effort human-readable extraction from provider error blobs.
 *
 * Some SDKs (notably Google GenAI) put JSON-RPC error bodies in `Error.message`,
 * sometimes double-encoded (`error.message` is a string containing more JSON).
 * Truncating that text for the UI mid-string breaks JSON.parse in clients and
 * shows raw `{"error":...` plus an ellipsis fragment.
 */

const DEFAULT_MAX_LEN = 500;

/**
 * Peel one layer of `{ "error": { "message": "..." } }` or `{ "message": "..." }`.
 * If `message` is a nested JSON string, returns it for the next iteration.
 */
function pickMessageField(obj: Record<string, unknown>): string | null {
  const err = obj['error'];
  if (err && typeof err === 'object') {
    const m = (err as Record<string, unknown>)['message'];
    if (typeof m === 'string') return m;
  }
  const m = obj['message'];
  return typeof m === 'string' ? m : null;
}

function peelOneJsonErrorLayer(s: string): string | null {
  const braceIdx = s.indexOf('{');
  if (braceIdx < 0) return null;
  try {
    const parsed = JSON.parse(s.slice(braceIdx)) as Record<string, unknown>;
    const line = pickMessageField(parsed);
    if (typeof line !== 'string' || line.length === 0) return null;
    return line.trim();
  } catch {
    return null;
  }
}

/**
 * Unwrap nested JSON error strings (e.g. Google RPC) and cap length for display.
 * Safe to call on any string; returns trimmed input if nothing matches JSON.
 */
export function sanitizeTerminalErrorMessage(raw: string, maxLen = DEFAULT_MAX_LEN): string {
  let s = raw.trim();
  for (let i = 0; i < 8; i++) {
    const next = peelOneJsonErrorLayer(s);
    if (!next || next === s) break;
    s = next;
  }
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}
