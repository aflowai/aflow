import { z } from 'zod';
import { isHostSafeEgressEntry } from '../models/repoBinding.js';

// ---------------------------------------------------------------------------
// Curated OAuth issuer registry (Plan 185 O4)
// ---------------------------------------------------------------------------
//
// A code-backed registry of well-known OAuth 2.1 authorization servers, mirroring
// the Plan 67 `getProviderDefinition` pattern. Keyed by a stable `issuerKey`, an
// entry pre-fills the authorization-server endpoints, default scopes, and the
// incremental-auth capability flag so the binding editor and the 218 P4 connector
// cards can offer a curated picker.
//
// The registry is ADDITIVE, never a gate: free-form authorization-server / token
// URLs on the `oauth2_authorization_code` auth profile remain a valid escape
// hatch for un-registered issuers. `getOAuthIssuer` returning `undefined` is a
// supported state, not an error.

/**
 * How an entry surfaces its authorization-server + token endpoints. Either a
 * discovery URL (RFC 8414 / OIDC `.well-known` document the platform fetches at
 * connect time) or the two endpoints directly. Exactly one form per entry.
 */
export const OAuthIssuerEndpointsSchema = z.union([
  z
    .object({
      /** RFC 8414 / OIDC discovery document URL — the platform derives the AS + token endpoints from it. */
      discoveryUrl: z.string().url(),
      /**
       * Curated hosts of the authorization + token endpoints the discovery
       * document resolves to. Discovery happens at connect time, but the host
       * manifest / tenant-allowlist surface is judged before any fetch — so a
       * discovery-based entry must declare its endpoint hosts up front.
       */
      endpointHosts: z
        .array(
          z.string().min(1).max(255).refine(isHostSafeEgressEntry, {
            message: 'Endpoint hosts must be bare hostnames — no scheme, port, path, or userinfo.',
          }),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      authorizationServer: z.string().url(),
      tokenEndpoint: z.string().url(),
    })
    .strict(),
]);
export type OAuthIssuerEndpoints = z.infer<typeof OAuthIssuerEndpointsSchema>;

export const OAuthIssuerDefinitionSchema = z.object({
  /** Stable registry key — also the `issuerKey` stamped on bindings and oauth_clients. */
  issuerKey: z.string().min(1).max(64),
  displayName: z.string().min(1).max(128),
  description: z.string().max(500).optional(),
  iconName: z.string().max(64).optional(),
  docsUrl: z.string().url().optional(),
  endpoints: OAuthIssuerEndpointsSchema,
  /** Scopes requested by default when no per-binding scopes are set. */
  defaultScopes: z.array(z.string().max(256)).default([]),
  /**
   * RFC-style incremental authorization support (O1): when true, a re-consent for
   * additional scopes can request only the delta and the AS returns a token whose
   * grant is the union. When false, every re-consent must request the full scope
   * set. Drives the §9.3 incremental-re-consent path.
   */
  incrementalAuth: z.boolean(),
});
export type OAuthIssuerDefinition = z.infer<typeof OAuthIssuerDefinitionSchema>;
