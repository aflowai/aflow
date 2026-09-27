import type { ConnectorCredentialPrompt } from '@aflow/schemas';

export const ETORO_BASE_URL = 'https://public-api.etoro.com';

/**
 * eToro authenticates with an application key and a user key in two distinct
 * headers; a request carrying `Authorization` alongside either is rejected
 * with 422, so the Basic collapse other two-credential providers allow is not
 * available here.
 */
export const ETORO_KEY_PAIR_HEADERS = {
  primary: 'x-api-key',
  secondary: 'x-user-key',
} as const;

/**
 * Pinned so the three eToro connectors resolve ONE pasted pair rather than one
 * pair each. Credentials are keyed `(credential_key, space_id)`, so a shared
 * name is a shared value — the split into three connectors buys per-surface
 * egress and grant narrowing without charging the operator three times for it.
 */
export const ETORO_API_KEY_CREDENTIAL = 'etoro-api-key';
export const ETORO_USER_KEY_CREDENTIAL = 'etoro-user-key';

export const ETORO_CREDENTIAL_PROMPTS: ConnectorCredentialPrompt[] = [
  {
    authField: 'credentialKey',
    credentialKey: ETORO_API_KEY_CREDENTIAL,
    label: 'eToro public API key',
    setupNote:
      'The Public API Key from api-portal.etoro.com → Settings → Trading → API Key ' +
      'Management. Sent as the x-api-key header.',
  },
  {
    authField: 'secondaryCredentialKey',
    credentialKey: ETORO_USER_KEY_CREDENTIAL,
    label: 'eToro user key',
    setupNote:
      'The User Key issued alongside the API key. It is displayed once at creation and ' +
      'cannot be retrieved again. Sent as the x-user-key header.',
  },
];
