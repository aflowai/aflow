import { stableStringify } from '../utils/stableHash.js';

const REDACTED = '[redacted]';

// Keys whose values are secrets or high-sensitivity PII — never surfaced in a
// write preview or persisted with one. Matched case-insensitively as a
// substring so `apiKey`, `x-api-key`, `clientSecret`, `access_token`, etc. all hit.
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'api-key',
  'authorization',
  'auth',
  'credential',
  'private',
  'ssn',
  'cvv',
  'cvc',
  'card_number',
  'cardnumber',
  'pin',
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * Deep-copy `value` with the values of sensitive-looking keys replaced by
 * `[redacted]`. Structure and non-sensitive values are preserved, so a reader
 * sees the shape and content of a write without the preview becoming a place
 * secrets get persisted or displayed.
 */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactSensitive(v);
    }
    return out;
  }
  return value;
}

export const WRITE_PREVIEW_MAX_CHARS = 4000;

/**
 * A redacted, bounded text preview of what a write would send. A raw string or
 * byte body carries no key structure to redact selectively, so it is never
 * previewed. Absent for an absent body.
 */
export function previewWrite(
  body: unknown,
  maxChars: number = WRITE_PREVIEW_MAX_CHARS,
): string | undefined {
  if (body === undefined || body === null) return undefined;
  const redacted =
    typeof body === 'string' || body instanceof Uint8Array
      ? '[binary or opaque body]'
      : redactSensitive(body);
  const s = typeof redacted === 'string' ? redacted : stableStringify(redacted);
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}
