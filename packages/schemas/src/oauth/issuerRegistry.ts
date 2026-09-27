import type { OAuthIssuerDefinition } from './issuer.js';

// ---------------------------------------------------------------------------
// Seed entries
// ---------------------------------------------------------------------------
//
// A small set of real, widely-used issuers. The registry is additive — a binding
// may always carry free-form authorization-server / token URLs for an issuer that
// is not listed here.

export const OAUTH_ISSUER_REGISTRY: readonly OAuthIssuerDefinition[] = [
  {
    issuerKey: 'google',
    displayName: 'Google',
    description: 'Google / Google Workspace accounts (Gmail, Drive, Calendar).',
    iconName: 'GoogleLogo',
    docsUrl: 'https://developers.google.com/identity/protocols/oauth2',
    endpoints: {
      discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
      endpointHosts: ['accounts.google.com', 'oauth2.googleapis.com'],
    },
    defaultScopes: ['openid', 'email', 'profile'],
    incrementalAuth: true,
  },
  {
    issuerKey: 'github',
    displayName: 'GitHub',
    description: 'GitHub accounts and organizations.',
    iconName: 'GithubLogo',
    docsUrl: 'https://docs.github.com/en/apps/oauth-apps',
    endpoints: {
      authorizationServer: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
    },
    defaultScopes: ['read:user'],
    incrementalAuth: false,
  },
  {
    issuerKey: 'microsoft',
    displayName: 'Microsoft',
    description: 'Microsoft / Entra ID accounts (Microsoft 365, Outlook).',
    iconName: 'MicrosoftLogo',
    docsUrl: 'https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow',
    endpoints: {
      discoveryUrl:
        'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
      endpointHosts: ['login.microsoftonline.com'],
    },
    defaultScopes: ['openid', 'email', 'profile', 'offline_access'],
    incrementalAuth: true,
  },
  {
    issuerKey: 'slack',
    displayName: 'Slack',
    description: 'Slack workspaces.',
    iconName: 'SlackLogo',
    docsUrl: 'https://api.slack.com/authentication/oauth-v2',
    endpoints: {
      authorizationServer: 'https://slack.com/oauth/v2/authorize',
      tokenEndpoint: 'https://slack.com/api/oauth.v2.access',
    },
    defaultScopes: [],
    incrementalAuth: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Lookup helpers (mirror credentials/registry.ts accessor surface)
// ---------------------------------------------------------------------------

const registryMap = new Map<string, OAuthIssuerDefinition>(
  OAUTH_ISSUER_REGISTRY.map((i) => [i.issuerKey, i]),
);

/** Get a curated issuer definition by key, or undefined if unregistered (a supported state). */
export function getOAuthIssuer(issuerKey: string): OAuthIssuerDefinition | undefined {
  return registryMap.get(issuerKey);
}

/** Get all curated issuer definitions. */
export function getAllOAuthIssuers(): readonly OAuthIssuerDefinition[] {
  return OAUTH_ISSUER_REGISTRY;
}

/** Get all curated issuer keys. */
export function getAllOAuthIssuerKeys(): string[] {
  return OAUTH_ISSUER_REGISTRY.map((i) => i.issuerKey);
}
