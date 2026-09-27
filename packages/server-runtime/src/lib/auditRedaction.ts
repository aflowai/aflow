/**
 * What an audit record is allowed to keep.
 *
 * `details` is a free-form bag filled by each call site, so the set of keys is
 * whatever anyone has ever passed — and an audit row is the one record designed
 * to be retained, exported and read by people who were not present. A token
 * that reaches it is retained on purpose, which is worse than one that reaches
 * a log with a retention window.
 *
 * Redacting here rather than at the call sites is the point: a rule applied by
 * nineteen callers is nineteen chances to forget, and the twentieth caller has
 * not been written yet.
 */

/**
 * Key fragments whose value is never evidence.
 *
 * Matched as substrings against the lowercased key, because the shapes in the
 * wild are `apiKey`, `api_key`, `X-Api-Key` and `credentialKey` — a set of
 * exact names would be a list of the ones already seen.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credential',
  'privatekey',
  'private_key',
  'clientsecret',
  'client_secret',
  'signature',
  'passphrase',
] as const;

/** What replaces a redacted value — a marker, not an empty string. */
export const REDACTED = '[redacted]';

/**
 * A signed URL is sensitive in its query string rather than its key, so it is
 * matched on the value. Any of these parameters means the URL carries its own
 * authorization and must not be retained whole.
 */
const SIGNED_URL_MARKERS = ['x-goog-signature', 'x-amz-signature', 'signature=', 'sig=', 'token='];

/** Beyond this, a value is a payload rather than a description of one. */
const MAX_RETAINED_STRING = 2048;

/** Separators are removed from BOTH sides, so `api_key`, `api-key`, `apiKey`
 *  and `X-Api-Key` all reduce to the same thing before comparison. */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[-_\s]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const k = normalizeKey(key);
  return SENSITIVE_KEY_FRAGMENTS.some((f) => k.includes(normalizeKey(f)));
}

function redactString(value: string): string {
  const lower = value.toLowerCase();
  if (SIGNED_URL_MARKERS.some((m) => lower.includes(m))) {
    // The origin and path are the diagnostic part; the query is the credential.
    const q = value.indexOf('?');
    return q > 0 ? `${value.slice(0, q)}?${REDACTED}` : REDACTED;
  }
  if (value.length > MAX_RETAINED_STRING) {
    return `${value.slice(0, MAX_RETAINED_STRING)}…[truncated ${String(value.length)} chars]`;
  }
  return value;
}

/**
 * Depth is bounded because `details` is caller-shaped: a self-referential or
 * pathologically nested object would otherwise turn an audit write into an
 * unbounded walk on a path that must not be able to fail.
 */
const MAX_DEPTH = 8;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redactValue(v, depth + 1);
  }
  return out;
}

/** Redact an audit `details` bag in place of trusting its author. */
export function redactAuditDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  return redactValue(details, 0) as Record<string, unknown>;
}
