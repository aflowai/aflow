/**
 * MCP-specific derivation of the provider-agnostic OAuth selectors from a
 * `McpServerBinding` + its `McpServerDefinition`.
 *
 * Consolidates the discovery descriptor, the per-issuer `issuerKey`, and the
 * platform `client_id` (CIMD metadata URL) so the consent route, the callback
 * resolver, the orchestrator inline consent op, and the executor all build the
 * same `OAuthBindingTarget`/`McpDiscovery` shape rather than each re-deriving it.
 */
import {
  extractUrlOrigin,
  mcpPrivateNetworkDeploymentHosts,
  parseMcpPrivateNetworkAcknowledgment,
  processEditionDescriptor,
} from '@aflow/schemas';
import type { McpServerBinding, McpServerDefinition } from '@aflow/schemas';
import { privateNetworkPolicyFor, type PrivateNetworkPolicy } from '@aflow/network-safety';
import { resolveCimdDocumentUrl } from './config.js';
import type { McpDiscovery } from './tokenManager.js';

/**
 * The policy an MCP definition's stored acknowledgment yields in this
 * process. Every MCP caller reads it from here: the executor's space loader
 * once per definition, and the API server for consent. The edition rule is
 * applied again at every read, so a record that predates a change to
 * `MCP_PRIVATE_NETWORK_HOSTS`, or arrived in a copied database, is refused
 * rather than honoured.
 */
export function mcpPrivateNetworkPolicy(
  storedRecord: unknown,
  env: NodeJS.ProcessEnv = process.env,
): PrivateNetworkPolicy {
  return privateNetworkPolicyFor({
    acknowledgment: parseMcpPrivateNetworkAcknowledgment(storedRecord),
    edition: processEditionDescriptor().edition,
    deploymentHosts: mcpPrivateNetworkDeploymentHosts(env),
  });
}

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
  privateNetwork: PrivateNetworkPolicy,
): McpOAuthDescriptor {
  const auth = binding.auth;
  const authorizationServer =
    auth.type === 'oauth2_pkce' || auth.type === 'oauth2_cimd'
      ? auth.authorizationServer
      : undefined;

  const discovery: McpDiscovery = {
    serverUrl: definition.serverUrl,
    privateNetwork,
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
