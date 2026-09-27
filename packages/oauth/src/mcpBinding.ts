/**
 * MCP-specific derivation of the provider-agnostic OAuth selectors from a
 * `McpServerBinding` + its `McpServerDefinition`.
 *
 * Consolidates the discovery descriptor, the per-issuer `issuerKey`, and the
 * platform `client_id` (CIMD metadata URL) so the consent route, the callback
 * resolver, the orchestrator inline consent op, and the executor all build the
 * same `OAuthBindingTarget`/`McpDiscovery` shape rather than each re-deriving it.
 */
import { extractUrlOrigin } from '@aflow/schemas';
import type { McpServerBinding, McpServerDefinition } from '@aflow/schemas';
import { resolveCimdDocumentUrl } from './config.js';
import type { McpDiscovery } from './tokenManager.js';

export interface McpOAuthDescriptor {
  discovery: McpDiscovery;
  /** Per-issuer disambiguator for tenant/space `oauth_clients` lookups. */
  issuerKey: string;
  /** Platform `client_id` (CIMD metadata URL); used only when clientScope='platform'. */
  platformClientId: string;
}

/** Origin of `url`, or the raw string when it is not a parseable URL. */
function originOf(url: string): string {
  try {
    return extractUrlOrigin(url);
  } catch {
    return url;
  }
}

/**
 * Derive the MCP discovery descriptor + client selectors. Only valid for the
 * consent-based OAuth auth types (`oauth2_pkce` / `oauth2_cimd`); the caller is
 * responsible for gating other auth types upstream.
 */
export function buildMcpOAuthDescriptor(
  binding: McpServerBinding,
  definition: McpServerDefinition,
): McpOAuthDescriptor {
  const auth = binding.auth;
  const authorizationServer =
    auth.type === 'oauth2_pkce' || auth.type === 'oauth2_cimd'
      ? auth.authorizationServer
      : undefined;

  const discovery: McpDiscovery = {
    serverUrl: definition.serverUrl,
    ...(definition.protectedResourceMetadataPath
      ? { protectedResourceMetadataPath: definition.protectedResourceMetadataPath }
      : {}),
    ...(authorizationServer ? { authorizationServer } : {}),
  };

  // CIMD bindings carry the platform client_id directly (SEP-991); a platform
  // pkce binding falls back to the hosted CIMD document URL.
  const platformClientId =
    auth.type === 'oauth2_cimd' ? auth.clientIdMetadataUrl : resolveCimdDocumentUrl();

  return {
    discovery,
    issuerKey: authorizationServer ?? originOf(definition.serverUrl),
    platformClientId,
  };
}
