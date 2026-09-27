const DEFAULT_API_BASE_URL = 'http://localhost:3000';
const CALLBACK_PATH = '/v1/oauth/callback';
const CIMD_PATH = '/.well-known/cimd';

function normalizedBaseUrl(): string {
  const base = process.env['API_BASE_URL'] ?? DEFAULT_API_BASE_URL;
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

/**
 * The canonical OAuth callback URL, e.g. `https://api.aflow.ai/v1/oauth/callback`.
 *
 * NOT user-supplied — any caller-controlled override would be an
 * open-redirect vector and would diverge from the redirect_uris published
 * in our CIMD document.
 */
export function resolveOAuthCallbackUrl(): string {
  return `${normalizedBaseUrl()}${CALLBACK_PATH}`;
}

/**
 * The canonical CIMD document URL, e.g. `https://api.aflow.ai/.well-known/cimd`.
 *
 * Used by `oauth2_cimd` bindings as `clientIdMetadataUrl` (SEP-991): the AS
 * dereferences this during consent to learn the client name, redirect URIs,
 * and supported grants — no DCR required.
 */
export function resolveCimdDocumentUrl(): string {
  return `${normalizedBaseUrl()}${CIMD_PATH}`;
}
