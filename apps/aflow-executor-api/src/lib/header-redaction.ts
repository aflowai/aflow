/**
 * Sensitive header redaction for API executor.
 *
 * Plan P5: Every call is traceable, with sensitive data redacted.
 * Authorization, Cookie, Set-Cookie, and custom-configured headers
 * are stripped from logged/returned response headers.
 */

const DEFAULT_SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-user-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'www-authenticate',
]);

/**
 * Redact sensitive headers from a headers record.
 * Returns a new object with sensitive values replaced by '[REDACTED]'.
 */
export function redactHeaders(
  headers: Record<string, string>,
  extraSensitive?: string[],
): Record<string, string> {
  const sensitive = new Set(DEFAULT_SENSITIVE_HEADERS);
  if (extraSensitive) {
    for (const h of extraSensitive) {
      sensitive.add(h.toLowerCase());
    }
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = sensitive.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return result;
}

/**
 * Strip sensitive headers entirely (don't include them at all).
 * Used for response headers returned to callers.
 */
export function stripSensitiveHeaders(
  headers: Record<string, string>,
  extraSensitive?: string[],
): Record<string, string> {
  const sensitive = new Set(DEFAULT_SENSITIVE_HEADERS);
  if (extraSensitive) {
    for (const h of extraSensitive) {
      sensitive.add(h.toLowerCase());
    }
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!sensitive.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}
