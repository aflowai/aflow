export {
  discoverPRM,
  discoverPRMReactive,
  clearPrmCacheForTests,
  type ProtectedResourceMetadata,
  type DiscoverPrmOptions,
  type PrmDiscoveryResult,
  type PrmDiscoverySource,
} from './prmDiscovery.js';

export {
  discoverAsMetadata,
  clearAsCacheForTests,
  type AsMetadata,
  type DiscoverAsMetadataOptions,
} from './asMetadata.js';

export { parseWwwAuthenticateResourceMetadata } from './parseWwwAuth.js';

export { resolveOAuthCallbackUrl, resolveCimdDocumentUrl } from './config.js';

export { buildMcpOAuthDescriptor, type McpOAuthDescriptor } from './mcpBinding.js';

export {
  resolveOAuthOwner,
  type OAuthOwnerScope,
  type OAuthOwnerContext,
  type OAuthOwnerNeedsConsentReason,
  type ResolveOAuthOwnerResult,
} from './resolver.js';

export {
  resolveOAuthClient,
  type OAuthClientScope,
  type ResolveOAuthClientParams,
  type ResolveOAuthClientResult,
} from './clientResolution.js';

export {
  startConsent,
  completeConsent,
  getValidAccessToken,
  reapExpiredOauthState,
  generatePkce,
  generateStateToken,
  parseStateToken,
  type IntegrationKind,
  type McpDiscovery,
  type OAuthBindingTarget,
  type PkcePair,
  type StartConsentParams,
  type StartConsentResult,
  type CompleteConsentParams,
  type CompleteConsentContext,
  type CompleteConsentResult,
  type GetValidAccessTokenParams,
  type GetValidAccessTokenResult,
} from './tokenManager.js';

// The Auth0 Management client is not re-exported. Its only consumer is the
// invite flow, which is the hosted product's; a core barrel publishing it makes
// this package look like it needs a hosted identity provider to do OAuth, which
// it does not. Imported by path where the hosted surfaces need it.
