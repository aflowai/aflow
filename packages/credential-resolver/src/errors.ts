import { getProviderDefinition } from '@aflow/schemas';
import type { CredentialScope } from '@aflow/schemas';

/**
 * Build a user-facing error message for a missing credential.
 */
export function credentialMissingMessage(providerId: string): string {
  const def = getProviderDefinition(providerId);
  const name = def?.displayName ?? providerId;
  return (
    `${name} API key is required but not configured. ` +
    `Add your key in Settings → Credentials → ${name}, ` +
    `or ask your space/tenant admin to configure a shared key.`
  );
}

/**
 * Build a user-facing error message for a credential auth error.
 */
export function credentialAuthErrorMessage(
  providerId: string,
  scope: CredentialScope,
  errorCode: string,
): string {
  const def = getProviderDefinition(providerId);
  const name = def?.displayName ?? providerId;

  if (scope === 'user') {
    return (
      `Your ${name} API key returned an authentication error (${errorCode}). ` +
      `Update your key in Settings → Credentials → ${name}. ` +
      `To use a space or tenant key instead, remove your personal key first.`
    );
  }
  if (scope === 'space') {
    return (
      `The space ${name} key returned an authentication error (${errorCode}). ` +
      `Ask your space admin to update it in Space Settings → Credentials, ` +
      `or add your own key in Settings → Credentials → ${name}.`
    );
  }
  // tenant
  return (
    `The tenant ${name} key returned an authentication error (${errorCode}). ` +
    `Ask your tenant admin to update it in Tenant Settings → Credentials, ` +
    `or add your own key in Settings → Credentials → ${name}.`
  );
}
