import type { ApiBindingSummary } from '../../hooks/use-integrations.js';

export interface AuthSlot {
  /** The field on `auth_json` to write the credential KEY into. */
  authField: string;
  /** Label shown above the credential-key input. */
  keyInputLabel: string;
  /** Label shown above the secret-value input. */
  secretInputLabel: string;
  /** Suggested credential-key name, derived from the connection ID. */
  defaultKey: (bindingId: string) => string;
  /** Server-side credential label (used as a hint when PUTting). */
  credentialLabel: (bindingId: string) => string;
}

export interface AuthSlots {
  primary?: AuthSlot | undefined;
  secondary?: AuthSlot | undefined;
}

export function getAuthSlots(authType: string): AuthSlots {
  switch (authType) {
    case 'bearer':
      return {
        primary: {
          authField: 'credentialKey',
          keyInputLabel: 'Token credential key',
          secretInputLabel: 'Bearer token value',
          defaultKey: (id) => `${id}-token`,
          credentialLabel: (id) => `Bearer token for ${id}`,
        },
      };
    case 'api_key':
      return {
        primary: {
          authField: 'credentialKey',
          keyInputLabel: 'API key credential key',
          secretInputLabel: 'API key value',
          defaultKey: (id) => `${id}-key`,
          credentialLabel: (id) => `API key for ${id}`,
        },
      };
    case 'api_key_pair':
      return {
        primary: {
          authField: 'credentialKey',
          keyInputLabel: 'First API key — credential key',
          secretInputLabel: 'First API key — value',
          defaultKey: (id) => `${id}-key`,
          credentialLabel: (id) => `Primary API key for ${id}`,
        },
        secondary: {
          authField: 'secondaryCredentialKey',
          keyInputLabel: 'Second API key — credential key',
          secretInputLabel: 'Second API key — value',
          defaultKey: (id) => `${id}-secondary-key`,
          credentialLabel: (id) => `Secondary API key for ${id}`,
        },
      };
    case 'basic':
      return {
        primary: {
          authField: 'usernameCredentialKey',
          keyInputLabel: 'Username (or API Key ID) — credential key',
          secretInputLabel: 'Username (or API Key ID) — value',
          defaultKey: (id) => `${id}-username`,
          credentialLabel: (id) => `Basic-auth username for ${id}`,
        },
        secondary: {
          authField: 'passwordCredentialKey',
          keyInputLabel: 'Password (or API Secret Key) — credential key',
          secretInputLabel: 'Password (or API Secret Key) — value',
          defaultKey: (id) => `${id}-secret`,
          credentialLabel: (id) => `Basic-auth password for ${id}`,
        },
      };
    case 'oauth2':
      return {
        primary: {
          authField: 'clientIdCredentialKey',
          keyInputLabel: 'Client ID — credential key',
          secretInputLabel: 'Client ID — value',
          defaultKey: (id) => `${id}-client-id`,
          credentialLabel: (id) => `OAuth2 client ID for ${id}`,
        },
        secondary: {
          authField: 'clientSecretCredentialKey',
          keyInputLabel: 'Client Secret — credential key',
          secretInputLabel: 'Client Secret — value',
          defaultKey: (id) => `${id}-client-secret`,
          credentialLabel: (id) => `OAuth2 client secret for ${id}`,
        },
      };
    case 'none':
    default:
      return {};
  }
}

interface AuthJsonShape {
  type?: unknown;
  credentialKey?: unknown;
  secondaryCredentialKey?: unknown;
  usernameCredentialKey?: unknown;
  passwordCredentialKey?: unknown;
  clientIdCredentialKey?: unknown;
  clientSecretCredentialKey?: unknown;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

export function isAuthHalfBuilt(binding: ApiBindingSummary): boolean {
  const auth = binding.auth as AuthJsonShape;
  if (auth.type === 'basic') {
    return (
      !nonEmptyString(auth.usernameCredentialKey) || !nonEmptyString(auth.passwordCredentialKey)
    );
  }
  if (auth.type === 'oauth2_client_credentials') {
    return (
      !nonEmptyString(auth.clientIdCredentialKey) || !nonEmptyString(auth.clientSecretCredentialKey)
    );
  }
  if (auth.type === 'api_key_pair') {
    return !nonEmptyString(auth.credentialKey) || !nonEmptyString(auth.secondaryCredentialKey);
  }
  return false;
}
