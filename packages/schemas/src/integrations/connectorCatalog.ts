import { z } from 'zod';
import { ApiDefinitionSchema } from '../models/apiDefinition.js';
import { McpServerDefinitionSchema } from '../models/mcpServerDefinition.js';

/**
 * Honesty label for a catalog connector — how the embedded definition came to
 * be. `curated` is a hand-vetted definition; `generated-validated` is one an
 * agent authored and the platform validated. Surfaced on the connector card so
 * an operator knows the provenance before installing.
 */
export const ConnectorHonestyLabelSchema = z.enum(['curated', 'generated-validated']);
export type ConnectorHonestyLabel = z.infer<typeof ConnectorHonestyLabelSchema>;

/**
 * Auth kind an API connector requires. Covers the static paste-credentials
 * subset of `AuthProfile.type` plus `oauth2_authorization_code` — the 3-legged
 * consent flow. An OAuth connector installs a consent-based binding (issuer +
 * ownership axes) and the install screen routes to the provider sign-in
 * instead of the paste-credentials path. The issuer the connector binds to is
 * carried on `ConnectorCatalogEntry.oauthIssuerKey`.
 */
export const ConnectorAuthKindSchema = z.enum([
  'bearer',
  'api_key',
  'api_key_pair',
  'basic',
  'none',
  'oauth2_authorization_code',
]);
export type ConnectorAuthKind = z.infer<typeof ConnectorAuthKindSchema>;

/**
 * A per-credential setup prompt the install screen renders alongside the
 * credential entry. Distinct from `ApiDefinition.variables[]` (NON-SECRET
 * baseUrlTemplate config) — `credentialPrompts` annotate the SECRET credential
 * fields (e.g. the JIRA API token or the bearer PAT) the operator must paste.
 */
export const ConnectorCredentialPromptSchema = z.object({
  /** The auth field this prompt annotates (e.g. `passwordCredentialKey`, `credentialKey`). */
  authField: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  setupNote: z.string().max(1000).optional(),
  /**
   * The credential key the installed binding names for this field. Omitted,
   * the binding derives `${bindingId}-*`, which is unique per connector and so
   * makes each entry demand its own paste of the same secret. Pinning a shared
   * name lets a family of entries that authenticate against ONE provider
   * account (eToro's market-data / account / trading split) resolve a single
   * pasted pair — credentials are keyed `(credential_key, space_id)`, so a
   * shared name is a shared value.
   */
  credentialKey: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-z0-9][a-z0-9-]*$/, {
      message: 'credentialKey must be a lowercase slug ([a-z0-9][a-z0-9-]*).',
    })
    .optional(),
});
export type ConnectorCredentialPrompt = z.infer<typeof ConnectorCredentialPromptSchema>;

/**
 * Listing surface shared by every connector payload — what the connector card
 * renders regardless of the definition substrate underneath.
 */
const ConnectorListingBaseSchema = z.object({
  catalogId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, {
      message: 'catalogId must be a slug ([a-z0-9_-]+).',
    }),
  version: z.number().int().min(1),
  name: z.string().min(1).max(128),
  tagline: z.string().min(1).max(256),
  description: z.string().min(1).max(2000),
  tags: z.array(z.string().min(1).max(64)).max(20).default([]),
  vendor: z.string().max(128).optional(),
  category: z.string().max(64).optional(),
  honestyLabel: ConnectorHonestyLabelSchema,
  /**
   * Per-SECRET-credential prompts the install screen renders. NON-SECRET
   * variable prompts ride `definition.variables[]` on API connectors.
   */
  credentialPrompts: z.array(ConnectorCredentialPromptSchema).max(10).optional(),
  /** Top-level guidance shown on the connector card / install screen. */
  setupNote: z.string().max(2000).optional(),
  /** Hidden entries are test fixtures only — excluded from the catalog list by default. */
  hidden: z.boolean().optional(),
});

/**
 * An installable API connector — a vetted `ApiDefinition` plus the
 * auth/variable prompts an operator needs to configure it once in a space.
 * Integration-tier (not a skill bundle): install registers the embedded
 * definition and creates a needs-configuration binding; the operator fills
 * credentials + variable values once, ratifies, and the integration is
 * `bound`.
 *
 * The definition is EMBEDDED (not referenced) so the entry is validated at
 * module load against the same `ApiDefinitionSchema` superRefine that gates
 * agent-authored and skill-granted definitions — one substrate, no fork.
 */
export const ConnectorCatalogEntrySchema = ConnectorListingBaseSchema.extend({
  authKind: ConnectorAuthKindSchema,
  /**
   * How calls through the installed binding are answered.
   *
   * `simulated` installs the contract against a world instead of a host: the
   * definition lands, a simulation is minted for it, and the binding is bound
   * on arrival because there is no credential to wait for. The API it describes
   * need not exist — which is the point, since an agent can then be built and
   * measured against a service nobody has written.
   *
   * It answers from the first call, by generation, and is tightened afterwards
   * by authoring collections, effects and handlers into the minted simulation.
   * So a listing carries the CONTRACT and never a world: a connector that
   * shipped seed rows would be smuggling content into an integration.
   *
   * Optional rather than defaulted, so the thirty entries written before this
   * existed stay untouched — absent is `live`, which is what they are.
   */
  fulfillment: z.enum(['live', 'simulated']).optional(),
  /**
   * For an `api_key` connector whose provider reads the key from a
   * non-default header, the header name the installed binding pins (e.g.
   * `Authorization` for providers that take the raw key there). Omitted, the
   * placeholder binding falls back to the auth profile's `X-API-Key` default.
   * Only valid when authKind is `api_key`.
   */
  apiKeyHeaderName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z][A-Za-z0-9-]*$/, {
      message: 'apiKeyHeaderName must be a valid HTTP header name ([A-Za-z][A-Za-z0-9-]*).',
    })
    .optional(),
  /**
   * For an `api_key` connector whose provider reads the key from a query
   * parameter (e.g. `?api_key=` for FRED, `?appid=` for OpenWeather), the
   * query-param name the installed binding pins. Setting this places the key
   * in the query string instead of a header — mutually exclusive with
   * `apiKeyHeaderName` (the two express opposite placements). Only valid when
   * authKind is `api_key`.
   */
  apiKeyQueryParamName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, {
      message:
        'apiKeyQueryParamName must be a valid query-parameter name ([A-Za-z][A-Za-z0-9_-]*).',
    })
    .optional(),
  /**
   * For an `api_key_pair` connector, the two header names the installed binding
   * pins (e.g. `x-api-key` + `x-user-key`). Required for that kind and
   * forbidden otherwise: an `ApiDefinition` carries no auth profile — auth
   * lives on the binding — so the listing is the only place the installer can
   * read them from. Only valid when authKind is `api_key_pair`.
   */
  apiKeyPairHeaderNames: z
    .object({
      primary: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z][A-Za-z0-9-]*$/, {
          message: 'primary must be a valid HTTP header name ([A-Za-z][A-Za-z0-9-]*).',
        }),
      secondary: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z][A-Za-z0-9-]*$/, {
          message: 'secondary must be a valid HTTP header name ([A-Za-z][A-Za-z0-9-]*).',
        }),
    })
    .optional(),
  /**
   * For an `oauth2_authorization_code` connector, the curated O4 issuer key the
   * install binds (e.g. `google`). Required for OAuth connectors, forbidden
   * otherwise — the install builds the consent-based auth profile from it and
   * the tenant policy's ownership defaults, then routes to provider sign-in.
   */
  oauthIssuerKey: z.string().min(1).max(64).optional(),
  /**
   * For an `oauth2_authorization_code` connector, the exact scopes this
   * connector's endpoints require. The install prefers these over the issuer's
   * `defaultScopes` (issuer defaults are a fallback, and for some issuers —
   * e.g. Slack — are empty). Optional: omit to fall back to the issuer
   * defaults. Only valid when authKind is `oauth2_authorization_code`.
   */
  oauthScopes: z.array(z.string().min(1).max(256)).max(50).optional(),
  /**
   * The vetted definition. Inherits the P1 superRefine: exactly one of
   * baseUrl|baseUrlTemplate, declared placeholders, typed body params.
   */
  definition: ApiDefinitionSchema,
}).superRefine((entry, ctx) => {
  // A simulated binding reaches no host, so there is nothing for a credential
  // to authenticate to. Declaring one would put a secret-shaped prompt on an
  // integration that can never use it, and leave the binding waiting for
  // configuration it does not need.
  if (entry.fulfillment === 'simulated' && entry.authKind !== 'none') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authKind'],
      message:
        'A simulated connector must declare authKind "none" — its calls are answered by a world, never sent to a host, so there is no credential to hold.',
    });
  }

  const isOAuth = entry.authKind === 'oauth2_authorization_code';
  if (isOAuth && !entry.oauthIssuerKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['oauthIssuerKey'],
      message:
        'An oauth2_authorization_code connector must declare oauthIssuerKey (the O4 issuer it binds, e.g. "google").',
    });
  }
  if (!isOAuth && entry.oauthIssuerKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['oauthIssuerKey'],
      message:
        'oauthIssuerKey is only valid when authKind is oauth2_authorization_code. Remove it for static-auth connectors.',
    });
  }
  if (!isOAuth && entry.oauthScopes !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['oauthScopes'],
      message:
        'oauthScopes is only valid when authKind is oauth2_authorization_code. Remove it for static-auth connectors.',
    });
  }
  const pinnedKeys = (entry.credentialPrompts ?? [])
    .map((prompt) => prompt.credentialKey)
    .filter((key): key is string => key !== undefined);
  if (new Set(pinnedKeys).size !== pinnedKeys.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['credentialPrompts'],
      message:
        'Two credential prompts pin the same credentialKey. Each auth field needs its own key — sharing one collapses both fields onto a single stored secret, so the second field is never prompted for and both are sent the same value.',
    });
  }
  if (entry.authKind === 'api_key_pair' && entry.apiKeyPairHeaderNames === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apiKeyPairHeaderNames'],
      message:
        'An api_key_pair connector must declare apiKeyPairHeaderNames — the two header names the binding sends (e.g. { primary: "x-api-key", secondary: "x-user-key" }). An ApiDefinition carries no auth profile, so the installer has no other source for them.',
    });
  }
  if (entry.apiKeyPairHeaderNames !== undefined && entry.authKind !== 'api_key_pair') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apiKeyPairHeaderNames'],
      message: 'apiKeyPairHeaderNames is only valid when authKind is api_key_pair.',
    });
  }
  if (
    entry.apiKeyPairHeaderNames !== undefined &&
    entry.apiKeyPairHeaderNames.primary.toLowerCase() ===
      entry.apiKeyPairHeaderNames.secondary.toLowerCase()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apiKeyPairHeaderNames', 'secondary'],
      message:
        'The two header names must differ — a pair that names one header twice sends only the second secret.',
    });
  }
  if (entry.apiKeyHeaderName !== undefined && entry.authKind !== 'api_key') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apiKeyHeaderName'],
      message: 'apiKeyHeaderName is only valid when authKind is api_key.',
    });
  }
  if (entry.apiKeyQueryParamName !== undefined && entry.authKind !== 'api_key') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apiKeyQueryParamName'],
      message: 'apiKeyQueryParamName is only valid when authKind is api_key.',
    });
  }
  if (entry.apiKeyHeaderName !== undefined && entry.apiKeyQueryParamName !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apiKeyQueryParamName'],
      message:
        'apiKeyHeaderName and apiKeyQueryParamName are mutually exclusive — a key goes in a header OR a query param, not both. Set exactly one (or neither, for the X-API-Key header default).',
    });
  }
});
export type ConnectorCatalogEntry = z.infer<typeof ConnectorCatalogEntrySchema>;

/**
 * The `McpAuthProfile` discriminators an MCP connector listing can install.
 * `header` and `oauth2_client_credentials` are excluded: their auth profiles
 * need structural fields (`headerName` / `tokenEndpoint`) a listing does not
 * carry, so a placeholder binding for them could never parse at read time.
 */
export const McpConnectorAuthKindSchema = z.enum(['none', 'bearer', 'oauth2_pkce', 'oauth2_cimd']);
export type McpConnectorAuthKind = z.infer<typeof McpConnectorAuthKindSchema>;

/**
 * An installable MCP connector — a vetted MCP server definition plus the
 * credential prompts an operator needs to configure its binding once in a
 * space. Install registers the embedded definition and creates a
 * needs-configuration binding; the binding test pins the server origin and
 * populates the tool cache before the binding is enabled.
 *
 * The definition is EMBEDDED for the same reason as the API entry: it
 * validates at module load against the substrate `mcp.server.upsert` writes.
 * Install stamps `source` and the timestamps, so they never ride the listing.
 *
 * No `oauthIssuerKey` here: MCP consent flows derive the issuer from the
 * definition's server URL or the auth profile's authorization server (PRM
 * discovery), so there is no curated issuer key to carry.
 */
export const McpConnectorCatalogEntrySchema = ConnectorListingBaseSchema.extend({
  authKind: McpConnectorAuthKindSchema,
  definition: McpServerDefinitionSchema.omit({
    source: true,
    createdAt: true,
    updatedAt: true,
  }),
});
export type McpConnectorCatalogEntry = z.infer<typeof McpConnectorCatalogEntrySchema>;
