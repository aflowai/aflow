/**
 * Credential resolution for API auth.
 *
 * Supports both legacy (synchronous) and envelope-encrypted (async KMS) formats.
 * The decryptCredentialAsync function auto-detects the format.
 */
import { decryptCredentialAsync } from '@aflow/database';
import { apiError } from '../../lib/api-errors.js';
import { INTEGRATIONS_URL } from './config.js';
import { ApiExecutionError } from './types.js';

export async function resolveCredentialOrThrow(
  credentialStore: ReadonlyMap<string, string>,
  apiId: string,
  credentialKey: string,
): Promise<string> {
  const encrypted = credentialStore.get(credentialKey);
  if (encrypted) {
    try {
      return await decryptCredentialAsync(encrypted);
    } catch {
      throw new ApiExecutionError(
        apiError(
          'API_AUTH_FAILED',
          `Failed to decrypt credential "${credentialKey}" for API "${apiId}". ` +
            'The encryption key may have changed.',
          { retryable: false, details: { apiId, credentialKey } },
        ),
      );
    }
  }

  throw new ApiExecutionError(
    apiError(
      'API_CREDENTIALS_NOT_CONFIGURED',
      `The API "${apiId}" requires a credential named "${credentialKey}". ` +
        `Setup: Go to ${INTEGRATIONS_URL}, click the "${apiId}" connection, ` +
        `and paste your API key or token as the value for "${credentialKey}". ` +
        'The binding references this key — once the value is stored, retry the call.',
      { retryable: false, details: { apiId, credentialKey } },
    ),
  );
}
