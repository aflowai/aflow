/**
 * API Definition + Binding model schemas.
 *
 * Implements the Definition vs Binding boundary from the API Executor v2 plan:
 * - **Definition**: what can be called (endpoints, schemas, transforms). No secrets.
 * - **Binding**: how it is authorized and governed (credentials, egress allowlist, ACL).
 *
 * Agents see Definitions. Bindings are managed outside flows by admins.
 */
import { z } from 'zod';
import { HttpMethodSchema } from '../operations/api.js';
import { ApiVariableValuesSchema, type ApiVariableValues } from './apiVariableValues.js';
import {
  BindingFulfillmentSchema,
  isSimulatedFulfillment,
  type BindingFulfillment,
} from './bindingFulfillment.js';
import { OAuthConsentOwnerScopeSchema } from '../runtime/sessionBlockedOn.js';
import { IconRefSchema } from '../store/iconRef.js';

// ============================================================================
// Auth Profiles (stored in Bindings, never visible to agents)
// ============================================================================

export const AuthTypeSchema = z.enum([
  'none',
  'api_key',
  'api_key_pair',
  'bearer',
  'basic',
  'oauth2_client_credentials',
  'oauth2_authorization_code',
]);
export type AuthType = z.infer<typeof AuthTypeSchema>;

// The client (app) ownership axis for 3-legged OAuth — whose registered OAuth
// application drives the flow (platform CIMD app, the org's own app, or a
// per-space app for a multi-org tenant). Orthogonal to the identity axis
// (ownerScope, reused from OAuthConsentOwnerScopeSchema).
export const OAuthClientScopeSchema = z.enum(['platform', 'tenant', 'space']);
export type OAuthClientScope = z.infer<typeof OAuthClientScopeSchema>;

export const ApiKeyPlacementSchema = z.enum(['header', 'query']);
export type ApiKeyPlacement = z.infer<typeof ApiKeyPlacementSchema>;

export const AuthProfileSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('none'),
  }),
  z.object({
    type: z.literal('api_key'),
    placement: ApiKeyPlacementSchema.default('header'),
    headerName: z.string().max(128).default('X-API-Key'),
    queryParamName: z.string().max(128).optional(),
    /**
     * Credential key to resolve at runtime from the user → API credential mapping.
     * This MUST NOT contain any secret material.
     *
     * Optional — when omitted, the binding is created as "needs configuration".
     * The user must go to the Integrations page to set the credential key and value.
     * Dev fallback (until real users/creds exist): treat this as an env var name.
     */
    credentialKey: z.string().max(256).optional(),
  }),
  // Two secrets carried in two distinct headers on the same request — the
  // application-key + user-key shape (eToro's `x-api-key` + `x-user-key`).
  // Distinct from `basic`, which also holds two credentials but collapses them
  // into one `Authorization` header: a provider that reads two named headers
  // cannot be served by that collapse. Fixed two slots rather than an array so
  // AUTH_CREDENTIAL_KEY_FIELDS stays a flat scalar scan.
  z.object({
    type: z.literal('api_key_pair'),
    primaryHeaderName: z.string().min(1).max(128),
    secondaryHeaderName: z.string().min(1).max(128),
    credentialKey: z.string().max(256).optional(),
    secondaryCredentialKey: z.string().max(256).optional(),
  }),
  z.object({
    type: z.literal('bearer'),
    /** Credential key (dev fallback: env var name). Optional — configure in Integrations page. */
    credentialKey: z.string().max(256).optional(),
  }),
  z.object({
    type: z.literal('basic'),
    usernameCredentialKey: z.string().max(256).optional(),
    passwordCredentialKey: z.string().max(256).optional(),
  }),
  z.object({
    type: z.literal('oauth2_client_credentials'),
    tokenEndpoint: z.string().url().max(2048),
    clientIdCredentialKey: z.string().max(256).optional(),
    clientSecretCredentialKey: z.string().max(256).optional(),
    scopes: z.array(z.string().max(128)).optional(),
  }),
  // 3-legged authorization-code OAuth. ownerScope (identity: whose tokens) and
  // clientScope (app: whose OAuth client) live HERE in auth_json, never in the
  // binding's variable_values_json (which carries only non-secret host labels).
  // Tokens are resolved server-side via @aflow/oauth keyed by
  // (integration_kind='api', resource_key=apiId, owner_scope, owner_id).
  z.object({
    type: z.literal('oauth2_authorization_code'),
    authorizationServer: z.string().url().optional(),
    tokenEndpoint: z.string().url().optional(),
    ownerScope: OAuthConsentOwnerScopeSchema,
    clientScope: OAuthClientScopeSchema,
    issuerKey: z.string(),
    scopes: z.array(z.string()).optional(),
    resource: z.string().url().optional(),
  }),
]);
export type AuthProfile = z.infer<typeof AuthProfileSchema>;

/**
 * Every field of an auth profile that names a stored credential (never secret
 * material itself). The single source for credential-key extraction and for
 * the same-type inherit rule in `normalizeBindingInput`.
 */
export const AUTH_CREDENTIAL_KEY_FIELDS = [
  'credentialKey',
  'secondaryCredentialKey',
  'usernameCredentialKey',
  'passwordCredentialKey',
  'clientIdCredentialKey',
  'clientSecretCredentialKey',
] as const;

export function extractCredentialKeys(authJson: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const field of AUTH_CREDENTIAL_KEY_FIELDS) {
    const value = authJson[field];
    if (typeof value === 'string') keys.push(value);
  }
  return keys;
}

// ============================================================================
// Endpoint Definition (part of an API Definition)
// ============================================================================

export const EndpointParamLocationSchema = z.enum(['path', 'query', 'header', 'body']);

export const EndpointParamSchema = z.object({
  name: z.string().max(128),
  location: EndpointParamLocationSchema,
  required: z.boolean().default(false),
  description: z.string().max(500).optional(),
  schema: z.record(z.unknown()).optional(),
  defaultValue: z
    .string()
    .max(512)
    .optional()
    .describe(
      'Sent as the parameter value when the caller omits it (path and query parameters). ' +
        'A real wire-level default, not an annotation.',
    ),
});
export type EndpointParam = z.infer<typeof EndpointParamSchema>;

export const BodyEncodingSchema = z.enum(['json', 'form-data', 'form-urlencoded']);
export type BodyEncoding = z.infer<typeof BodyEncodingSchema>;

/**
 * Human-approval risk tier for a write endpoint. Lives in the
 * orchestrator/executor plane and is NEVER surfaced to agents — an agent must
 * not be able to read the tier and route around the gate. See Plan 253.
 * - `read`: no remote state change (GET/HEAD).
 * - `low`: internal, reversible write the caller controls — runs unattended.
 * - `medium`: external-facing send or a not-easily-undone change — gated by default.
 * - `high`: financial movement or destructive-at-scale — always gated.
 */
export const WriteRiskTierSchema = z.enum(['read', 'low', 'medium', 'high']);
export type WriteRiskTier = z.infer<typeof WriteRiskTierSchema>;

export const ApiEndpointSchema = z.object({
  endpointId: z.string().max(128),
  name: z.string().max(256),
  description: z.string().max(2000).optional(),
  method: HttpMethodSchema,
  pathTemplate: z.string().max(2048),
  params: z.array(EndpointParamSchema).default([]),
  bodyEncoding: BodyEncodingSchema.default('json')
    .optional()
    .describe(
      'How to encode the request body. json (default): application/json. ' +
        'form-data: multipart/form-data. form-urlencoded: application/x-www-form-urlencoded.',
    ),
  responseSchemas: z
    .record(z.record(z.unknown()))
    .optional()
    .describe('Keyed by status class: 2xx, 4xx, 5xx'),
  pagination: z
    .object({
      style: z.enum(['cursor', 'offset', 'link']),
      cursorParam: z.string().max(128).optional(),
      limitParam: z.string().max(128).optional(),
    })
    .optional(),
  writeRiskTier: WriteRiskTierSchema.optional().describe(
    'Human-approval risk tier for this endpoint (Plan 253). When absent, the effective ' +
      'tier derives to `read` for GET/HEAD and `low` for any other method — the dangerous ' +
      'direction (a write that runs unattended at medium/high) always requires an explicit tier. ' +
      'Orchestrator/executor plane only; never exposed to agents.',
  ),
  responseTransformPresetId: z
    .string()
    .max(128)
    .optional()
    .describe(
      "The endpoint's curated default response transform — a platform-owned preset id that " +
        'normalizes a text (non-JSON) response body into compact typed JSON records before ' +
        'inline/reference shaping (e.g. arxiv_atom_papers for Atom XML). An explicit ' +
        'response.transformPresetId on the call takes precedence. Declared-transform failures ' +
        'are fail-loud (API_RESPONSE_TRANSFORM_FAILED), never a silent raw-body fallback.',
    ),
  tags: z.array(z.string().max(64)).max(20).default([]),
  examples: z
    .array(
      z.object({
        name: z.string().max(128),
        params: z.record(z.unknown()),
        description: z.string().max(500).optional(),
      }),
    )
    .max(10)
    .optional(),
});
export type ApiEndpoint = z.infer<typeof ApiEndpointSchema>;

/**
 * The effective write-risk tier for an endpoint. An explicit `writeRiskTier`
 * always wins; otherwise a GET/HEAD is `read` and every mutating method
 * defaults to `low` (never silently unattended at medium/high). Plan 253.
 */
export function effectiveWriteRiskTier(
  endpoint: Pick<ApiEndpoint, 'method' | 'writeRiskTier'>,
): WriteRiskTier {
  if (endpoint.writeRiskTier) return endpoint.writeRiskTier;
  return endpoint.method === 'GET' || endpoint.method === 'HEAD' ? 'read' : 'low';
}

/**
 * Whether a tier requires human approval by default (before any per-space
 * override). `medium` and `high` gate; `read` and `low` run unattended. The
 * single source of the default gate decision, shared by the executor gate and
 * the operator-override composition (Plan 253).
 */
export function writeRiskTierGatedByDefault(tier: WriteRiskTier): boolean {
  return tier === 'medium' || tier === 'high';
}

/**
 * Per-space override of the default write-approval gate (Plan 253 P3). Each
 * writable tier's gating can be raised or lowered; an absent entry falls back
 * to the built-in default. `read` is never gateable (it is not a write).
 * Lowering `high` (financial/destructive) is allowed — the operator's autonomy
 * escape valve — but the UI makes it a deliberate action; it is never a default.
 */
export const SpaceWriteApprovalPolicySchema = z.object({
  requireApprovalByTier: z
    .object({
      low: z.boolean().optional(),
      medium: z.boolean().optional(),
      high: z.boolean().optional(),
    })
    .optional(),
});
export type SpaceWriteApprovalPolicy = z.infer<typeof SpaceWriteApprovalPolicySchema>;

/**
 * Whether a write of `tier` requires human approval in a space — the built-in
 * default composed with the space's optional per-tier override, recomputed at
 * read (Plan 190). The single authority for the gate decision; the executor
 * gate and any surface reasoning about gating must go through this.
 */
export function requiresWriteApproval(
  tier: WriteRiskTier,
  policy?: SpaceWriteApprovalPolicy | null,
): boolean {
  if (tier === 'read') return false;
  const override = policy?.requireApprovalByTier?.[tier];
  if (override !== undefined) return override;
  return writeRiskTierGatedByDefault(tier);
}

// ============================================================================
// API Definition (catalog entry — no secrets)
// ============================================================================

/**
 * Optional egress policy hints that definition authors provide to help
 * binding creators configure correct egress policies. Merged as defaults
 * during `normalizeBindingInput()` — explicit binding values always win.
 */
export const SuggestedEgressPolicySchema = z
  .object({
    allowCrossHostRedirects: z
      .boolean()
      .optional()
      .describe(
        'Suggest enabling cross-host redirects (e.g., API redirects to CDN for file downloads).',
      ),
    additionalHosts: z
      .array(z.string().max(256))
      .max(20)
      .optional()
      .describe(
        'Extra hosts that should be allowed beyond the baseUrl (e.g., storage.googleapis.com for GCS redirects).',
      ),
    allowedMethods: z
      .array(HttpMethodSchema)
      .optional()
      .describe(
        'HTTP methods needed (e.g., ["GET", "POST", "PUT"] if the API uses signed upload URLs).',
      ),
    minResponseBodyBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Suggested minimum for maxResponseBodyBytes (e.g., 100 MB for file download APIs).',
      ),
    minTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Suggested minimum timeout (e.g., 60s for large transfers).'),
  })
  .describe(
    'Hints from the API definition author about egress policy requirements. ' +
      'These are merged as defaults when creating bindings — explicit binding values always override.',
  );
export type SuggestedEgressPolicy = z.infer<typeof SuggestedEgressPolicySchema>;

/**
 * How a definition's binding is called. `endpoint` (default) resolves
 * apiId + endpointId against the declared endpoints. `direct_url` is an
 * egress-allowlist-only binding called via api.http.call direct-URL mode
 * (apiId + bindingId + url) for signed/dynamic cross-host URLs an API returns
 * at runtime (e.g. a GCS upload URL) — it declares NO endpoints and carries no
 * credentials (auth is never applied in direct-URL mode).
 */
export const ApiCallModeSchema = z.enum(['endpoint', 'direct_url']);
export type ApiCallMode = z.infer<typeof ApiCallModeSchema>;

/**
 * A per-binding, NON-SECRET configuration value substituted into
 * `baseUrlTemplate` at call time (e.g. the JIRA subdomain `acme` in
 * `https://{domain}.atlassian.net`, a region, or an account id). Never a
 * token/password/secret — those stay in `api_credentials` referenced by the
 * binding's auth `*credentialKey`. Variable values may appear in resolved
 * URLs and logs, so secret material here would leak.
 */
export const ApiVariableSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
        message:
          'Variable name must be a valid identifier ([A-Za-z_][A-Za-z0-9_]*) so it can be referenced as {name} in baseUrlTemplate.',
      }),
    description: z.string().max(500),
    example: z.string().max(256).optional(),
    required: z.boolean().default(true),
  })
  .describe(
    'A per-binding, NON-SECRET baseUrlTemplate variable (subdomain/region/account-id). ' +
      'NEVER tokens or passwords — secrets stay in credentials referenced by auth.*credentialKey.',
  );
export type ApiVariable = z.infer<typeof ApiVariableSchema>;

export const ApiDefinitionSchema = z
  .object({
    apiId: z.string().max(128),
    name: z.string().max(256),
    description: z.string().max(2000).optional(),
    baseUrl: z.string().url().max(2048).optional(),
    baseUrlTemplate: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe(
        'A base URL TEMPLATE whose {name} placeholders are declared in variables[] and ' +
          "substituted from the binding's NON-SECRET variableValues at call time " +
          "(e.g. 'https://{domain}.atlassian.net'). Set EITHER baseUrl (variable-free) OR " +
          'baseUrlTemplate — never both, never neither.',
      ),
    variables: z
      .array(ApiVariableSchema)
      .max(20)
      .optional()
      .describe(
        'NON-SECRET per-binding variables (subdomain/region/account-id) declared for ' +
          'baseUrlTemplate. Each {name} placeholder in baseUrlTemplate MUST be declared here. ' +
          'NEVER tokens/passwords — secrets stay in credentials.',
      ),
    version: z.string().max(64).default('1'),
    callMode: ApiCallModeSchema.default('endpoint'),
    endpoints: z.array(ApiEndpointSchema),
    defaultHeaders: z.record(z.string()).optional(),
    /**
     * Header name to carry a per-call correlation id the executor mints (e.g.
     * `x-request-id`). Declared rather than written into `defaultHeaders`
     * because the VALUE cannot be a literal: providers that require it want a
     * fresh id per logical call, and those that treat it as a replay key on
     * write routes need the same id across retries of that call. A static
     * header would satisfy neither.
     */
    requestIdHeader: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z][A-Za-z0-9-]*$/, {
        message: 'requestIdHeader must be a valid HTTP header name ([A-Za-z][A-Za-z0-9-]*).',
      })
      .optional(),
    suggestedEgressPolicy: SuggestedEgressPolicySchema.optional(),
    icon: IconRefSchema.optional().describe(
      'How this integration is identified visually. Set explicitly, it wins over the ' +
        'curated icon the platform ships for well-known ids — which is what gives a ' +
        'hand-authored integration a way to have real artwork. Absent, the UI renders ' +
        'a deterministic initials tile; artwork is never required.',
    ),
    tags: z.array(z.string().max(64)).max(20).default([]),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .superRefine((def, ctx) => {
    const hasBaseUrl = def.baseUrl !== undefined;
    const hasTemplate = def.baseUrlTemplate !== undefined;
    if (hasBaseUrl && hasTemplate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrlTemplate'],
        message:
          'Set EITHER baseUrl (a concrete variable-free URL) OR baseUrlTemplate (with declared variables[]) — not both.',
      });
    } else if (!hasBaseUrl && !hasTemplate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message:
          'An API definition must set exactly one of baseUrl or baseUrlTemplate. Use baseUrl for a fixed host, or baseUrlTemplate (e.g. "https://{domain}.atlassian.net") with declared variables[] for a per-binding host.',
      });
    }
    if (hasBaseUrl && (def.baseUrl!.includes('{') || def.baseUrl!.includes('}'))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message:
          'baseUrl is a CONCRETE URL and must not contain a {placeholder}. For a per-binding host, move it to baseUrlTemplate (e.g. "https://{domain}.atlassian.net") and declare each placeholder in variables[].',
      });
    }
    if (hasBaseUrl && def.variables !== undefined && def.variables.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variables'],
        message:
          'variables[] only substitute into baseUrlTemplate. A definition with a concrete baseUrl must not declare variables[] — use baseUrlTemplate instead.',
      });
    }
    if (hasTemplate) {
      const template = def.baseUrlTemplate!;
      const declared = new Set((def.variables ?? []).map((v) => v.name));
      // Every {placeholder} must be a valid identifier (so it can be declared)
      // and declared in variables[]. The `*` (not `+`) also rejects empty `{}`
      // and names with spaces/punctuation that would otherwise ship literally.
      for (const match of template.matchAll(/\{([^}]*)\}/g)) {
        const name = match[1] ?? '';
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['baseUrlTemplate'],
            message: `baseUrlTemplate has an invalid placeholder "{${name}}". Placeholder names must be identifiers ([A-Za-z_][A-Za-z0-9_]*), e.g. {domain}.`,
          });
        } else if (!declared.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['variables'],
            message: `baseUrlTemplate references {${name}} but it is not declared in variables[]. Add a variable named "${name}" (non-secret: subdomain/region/account-id).`,
          });
        }
      }
      // A declared variable the template never references would leave the binding
      // perpetually "needs configuration" for a value that's never used.
      for (const v of def.variables ?? []) {
        if (!template.includes(`{${v.name}}`)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['variables'],
            message: `variable "${v.name}" is declared but not referenced in baseUrlTemplate. Remove it, or reference it as {${v.name}}.`,
          });
        }
      }
      // Once placeholders are filled the template must form an absolute http(s)
      // URL — catch a missing scheme/host at author time, not at call time.
      let probeUrl: URL | null = null;
      try {
        probeUrl = new URL(template.replace(/\{[^}]*\}/g, 'x'));
      } catch {
        probeUrl = null;
      }
      if (!probeUrl || (probeUrl.protocol !== 'http:' && probeUrl.protocol !== 'https:')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseUrlTemplate'],
          message:
            'baseUrlTemplate must be an absolute http(s) URL once placeholders are filled (e.g. "https://{domain}.atlassian.net").',
        });
      }
    }
    if (def.callMode === 'direct_url') {
      if (def.endpoints.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpoints'],
          message:
            "A direct_url definition declares NO endpoints — it is called via api.http.call direct-URL mode (apiId + bindingId + url). Drop the endpoints or set callMode to 'endpoint'.",
        });
      }
    } else if (def.endpoints.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoints'],
        message: 'An endpoint-mode API definition must declare at least one endpoint.',
      });
    }
    const seenEndpointIds = new Set<string>();
    for (const [epIdx, ep] of def.endpoints.entries()) {
      if (seenEndpointIds.has(ep.endpointId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpoints', epIdx, 'endpointId'],
          message: `Duplicate endpointId "${ep.endpointId}". Endpoints are keyed by endpointId — send one entry per endpoint.`,
        });
      }
      seenEndpointIds.add(ep.endpointId);
    }
    // A body-bearing endpoint must carry a typed body schema — otherwise the
    // promoted tool exposes `body` as an opaque object and the caller guesses
    // field names. The schema slot is the contract; it is not optional.
    for (const [epIdx, ep] of def.endpoints.entries()) {
      for (const [pIdx, param] of ep.params.entries()) {
        if (param.location === 'body' && param.schema === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['endpoints', epIdx, 'params', pIdx, 'schema'],
            message: `Endpoint "${ep.endpointId}" declares a request body but no body schema. A body param MUST carry a JSON Schema so the promoted tool is typed and the body is validated at call time.`,
          });
        }
      }
    }
  });
export type ApiDefinition = z.infer<typeof ApiDefinitionSchema>;

/**
 * Why a definition's base URL could not be resolved.
 *
 * `unavailable` is an origin nobody has supplied yet — the ordinary state of a
 * definition whose service does not exist. `invalid` is an origin somebody
 * supplied that may not be used: a value carrying URL structure would move the
 * authority the egress allowlist is written against. The two are not
 * interchangeable, because a caller may legitimately substitute an origin for
 * the first and never for the second.
 */
export type BaseUrlResolution =
  { ok: true; baseUrl: string } | { ok: false; reason: 'unavailable' | 'invalid'; message: string };

/**
 * Resolve a definition's effective base URL, reporting the failure rather than
 * throwing it. For a `baseUrl` definition this is the URL unchanged. For a
 * `baseUrlTemplate` definition it substitutes each `{name}` placeholder from
 * `variableValues` (the binding's NON-SECRET per-binding config).
 */
export function resolveBaseUrlResult(
  def: Pick<ApiDefinition, 'baseUrl' | 'baseUrlTemplate' | 'variables'>,
  variableValues: Record<string, string> | undefined,
): BaseUrlResolution {
  if (def.baseUrlTemplate === undefined) {
    if (def.baseUrl === undefined) {
      return {
        ok: false,
        reason: 'unavailable',
        message: 'API definition has neither baseUrl nor baseUrlTemplate; it cannot be resolved.',
      };
    }
    return { ok: true, baseUrl: def.baseUrl };
  }

  const values = variableValues ?? {};
  const variables = def.variables ?? [];
  const missing = variables
    .filter((v) => v.required && (values[v.name] === undefined || values[v.name] === ''))
    .map((v) => v.name);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'unavailable',
      message: `Binding needs configuration: required variable(s) ${missing
        .map((n) => `"${n}"`)
        .join(
          ', ',
        )} not set. Fill them on the binding's variableValues (non-secret: subdomain/region/account-id).`,
    };
  }

  for (const match of def.baseUrlTemplate.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1] ?? '';
    const value = values[name];
    if (value === undefined || value === '') {
      return {
        ok: false,
        reason: 'unavailable',
        message: `Binding needs configuration: baseUrlTemplate variable "${name}" has no value in variableValues.`,
      };
    }
    // A variable substitutes a non-secret host-safe value (subdomain/region/
    // account-id), never URL structure. Reject any character that could escape
    // the template's intended authority (`/`, `@`, `:`, `?`, `#`, whitespace,
    // backslash) — e.g. domain="evil.com/" turning the authority into evil.com.
    // This is the host-confinement boundary the egress allowlist relies on.
    if (!/^[A-Za-z0-9._-]+$/.test(value)) {
      return {
        ok: false,
        reason: 'invalid',
        message:
          `baseUrlTemplate variable "${name}" has an invalid value. Variable values are ` +
          'non-secret labels (subdomain/region/account-id) and may contain only letters, ' +
          'digits, dot, underscore, and hyphen — never URL structure (/, @, :, ?, #).',
      };
    }
  }

  return {
    ok: true,
    baseUrl: def.baseUrlTemplate.replace(
      /\{([^}]+)\}/g,
      (_match, name: string) => values[name] ?? '',
    ),
  };
}

/**
 * The throwing form. Throws a teaching error naming any required, unfilled
 * variable — this is the single substitution point both the executor and
 * readiness derive from (no persisted flag).
 */
export function resolveBaseUrl(
  def: Pick<ApiDefinition, 'baseUrl' | 'baseUrlTemplate' | 'variables'>,
  variableValues: Record<string, string> | undefined,
): string {
  const result = resolveBaseUrlResult(def, variableValues);
  if (!result.ok) throw new Error(result.message);
  return result.baseUrl;
}

// ============================================================================
// API Binding (credentials + governance — outside flows)
// ============================================================================

export const EgressPolicySchema = z.object({
  allowedHosts: z
    .array(z.string().max(256))
    .min(1)
    .describe(
      'Hosts the API is allowed to call. Required. Example: ["api.example.com", "*.example.com"]. ' +
        'Localhost and private IPs (127.x, 10.x, 172.16-31.x, 192.168.x) are always blocked. ' +
        'If omitted during binding creation, auto-derived from the API definition baseUrl.',
    ),
  allowedMethods: z
    .array(HttpMethodSchema)
    .default(['GET', 'POST'])
    .describe('HTTP methods allowed. Default: GET, POST.'),
  maxRequestBodyBytes: z
    .number()
    .int()
    .positive()
    .max(104_857_600)
    .default(1_048_576)
    .describe('Max request body size in bytes. Default: 1 MB. Max: 100 MB.'),
  maxResponseBodyBytes: z
    .number()
    .int()
    .positive()
    .max(524_288_000)
    .default(10_485_760)
    .describe(
      'Max response body size in bytes. Responses exceeding this are rejected (not truncated). ' +
        'Default: 10 MB. Max: 500 MB. Large responses are stored in PayloadStore (GCS) ' +
        'and referenced via PayloadRef — only a preview appears in step output.',
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(300_000)
    .default(30_000)
    .describe('Request timeout in milliseconds. Default: 30s. Max: 300s (5 min).'),
  maxRedirects: z
    .number()
    .int()
    .nonnegative()
    .max(10)
    .default(5)
    .describe('Max HTTP redirects to follow. Default: 5.'),
  allowCrossHostRedirects: z
    .boolean()
    .default(false)
    .describe('Allow redirects to a different host. Default: false.'),
  retryPolicy: z
    .object({
      maxRetries: z
        .number()
        .int()
        .nonnegative()
        .max(5)
        .default(2)
        .describe('Max retry attempts. Default: 2.'),
      retryableStatusCodes: z
        .array(z.number().int())
        .default([429, 502, 503, 504])
        .describe('HTTP status codes that trigger a retry. Default: 429, 502, 503, 504.'),
      retryOnlyIdempotent: z
        .boolean()
        .default(true)
        .describe('Only retry idempotent methods (GET, HEAD, PUT). Default: true.'),
      backoffBaseMs: z
        .number()
        .int()
        .positive()
        .default(1000)
        .describe('Initial backoff delay in ms. Default: 1000.'),
      backoffMaxMs: z
        .number()
        .int()
        .positive()
        .default(30_000)
        .describe('Max backoff delay in ms. Default: 30,000.'),
    })
    .default({}),
});
export type EgressPolicy = z.infer<typeof EgressPolicySchema>;

// Re-exported from zod-only leaf modules so consumers keep importing them from
// here / the schemas barrel; they live in ./apiVariableValues.js and
// ./bindingFulfillment.js to avoid an import cycle (operations/platform.ts also
// needs both, and platform.ts is value-imported by operations/api.ts, which
// apiDefinition.ts imports).
export { ApiVariableValuesSchema, BindingFulfillmentSchema, isSimulatedFulfillment };
export type { ApiVariableValues, BindingFulfillment };

export const ApiBindingSchema = z.object({
  bindingId: z.string().max(128),
  apiId: z.string().max(128),
  name: z.string().max(256),
  description: z.string().max(2000).optional(),
  scope: z.object({
    tenantId: z.string(),
    spaceId: z.string().optional(),
    flowId: z.string().optional(),
  }),
  auth: AuthProfileSchema,
  egressPolicy: EgressPolicySchema,
  variableValues: ApiVariableValuesSchema.optional().describe(
    "NON-SECRET per-binding config substituted into the definition's baseUrlTemplate " +
      "(e.g. { domain: 'acme' } for https://{domain}.atlassian.net). NEVER tokens or " +
      'passwords — secrets stay in api_credentials referenced by auth.*credentialKey. ' +
      'Values may appear in resolved URLs and logs.',
  ),
  fulfillment: BindingFulfillmentSchema.default({ mode: 'live' }).describe(
    'How calls through this binding are answered. Defaults to live, so an existing ' +
      'binding keeps its behaviour and simulation is something a row states rather ' +
      'than something it falls into.',
  ),
  enabled: z.boolean().default(true),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type ApiBinding = z.infer<typeof ApiBindingSchema>;

/**
 * Derive the egress host pattern from a `baseUrlTemplate` for binding-creation
 * allowlist seeding. The resolved host is enforced per-call at execution time;
 * this is only the create-time default. We keep the literal hostname portions
 * and replace each `{var}` placeholder with a `*` wildcard segment so e.g.
 * `https://{domain}.atlassian.net` derives `*.atlassian.net`. If the template
 * has no recognizable host (placeholder spans the whole authority), returns
 * undefined and the caller relies on the per-call resolved-host check.
 *
 * Distinct from `templateHostPattern` in the store host-manifest derivation:
 * that grammar only admits `*.suffix` patterns, so it must widen every label
 * up to the last placeholder into one leading wildcard, while this in-place
 * substitution can wildcard interior labels. Do not unify them.
 */
export function deriveHostFromBaseUrlTemplate(template: string): string | undefined {
  const withoutScheme = template.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const authority = withoutScheme.split('/')[0];
  if (authority === undefined || authority === '') return undefined;
  const host = authority.split('@').pop() ?? authority;
  const hostNoPort = host.replace(/:\d+$/, '');
  const wildcarded = hostNoPort.replace(/\{[^}]+\}/g, '*');
  if (wildcarded.replace(/[*.]/g, '') === '') return undefined;
  return wildcarded;
}

// ============================================================================
// Agent-Facing Discovery (what platform.list_api_definitions returns)
// ============================================================================

// ============================================================================
// Binding Normalization (used at creation time by server + orchestrator)
// ============================================================================

export interface NormalizeBindingInputOptions {
  rawAuth?: Record<string, unknown> | undefined;
  rawEgressPolicy?: Record<string, unknown> | undefined;
  definitionBaseUrl?: string | undefined;
  suggestedEgressPolicy?: SuggestedEgressPolicy | undefined;
  existingEgressPolicy?: Record<string, unknown> | undefined;
  existingAuth?: Record<string, unknown> | undefined;
  definitionBaseUrlTemplate?: string | undefined;
}

/**
 * Normalize raw binding input before storage. Validates auth, auto-derives
 * allowedHosts from the API definition's baseUrl, merges suggestedEgressPolicy
 * from the definition author, and applies egress defaults.
 *
 * Egress precedence per field: explicit `rawEgressPolicy` > `existingEgressPolicy`
 * (the binding's stored egress, passed by the caller on an update) > `suggestedEgressPolicy`
 * (a first-create default) > baseUrl-derived. Invariant: an update that omits egress
 * preserves the stored allowlist — a credential-only upsert must never silently narrow it.
 *
 * Auth follows the same preserve-on-omit invariant: an update that omits auth keeps
 * the stored `existingAuth` verbatim, and an update that provides auth with the SAME
 * type inherits every stored profile field it does not explicitly set (credential
 * keys, api-key placement/header/query names, token endpoints, scopes) — a partial
 * upsert must never silently degrade or reshape the binding. Providing a different
 * auth type replaces the profile wholesale (an intentional scheme change resets
 * credentials). Clearing a stored field is not expressible here — credential
 * rotation/removal is an operator action in /integrations.
 *
 * This function stays DB-free; the caller loads the stored auth + egress and passes them.
 *
 * Returns the fully-validated `auth` and `egressPolicy` objects ready for DB storage.
 * Throws a descriptive error if auth is invalid.
 */
export function normalizeBindingInput(options: NormalizeBindingInputOptions): {
  auth: AuthProfile;
  egressPolicy: EgressPolicy;
} {
  const {
    rawAuth,
    rawEgressPolicy,
    definitionBaseUrl,
    suggestedEgressPolicy,
    existingEgressPolicy,
    existingAuth,
    definitionBaseUrlTemplate,
  } = options;

  const providedAuth = rawAuth && Object.keys(rawAuth).length > 0 ? rawAuth : undefined;
  let effectiveAuth: Record<string, unknown>;
  if (!providedAuth) {
    effectiveAuth = existingAuth ?? {};
  } else if (existingAuth && providedAuth['type'] === existingAuth['type']) {
    effectiveAuth = { ...existingAuth, ...providedAuth };
  } else {
    effectiveAuth = providedAuth;
  }

  const authResult = AuthProfileSchema.safeParse(effectiveAuth);
  if (!authResult.success) {
    const issues = authResult.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(
      `Invalid auth configuration: ${issues}. ` +
        'Valid auth types: ' +
        '{ type: "none" }, ' +
        '{ type: "bearer" }, ' +
        '{ type: "basic" }, ' +
        '{ type: "api_key" }, ' +
        '{ type: "oauth2_client_credentials", tokenEndpoint: "URL" }, ' +
        '{ type: "oauth2_authorization_code", ... } (created by connector install/OAuth consent). ' +
        'Credential key fields are optional — configure them in the Integrations page.',
    );
  }

  const derivedHosts: string[] = [];
  if (definitionBaseUrl) {
    try {
      const host = new URL(definitionBaseUrl).hostname;
      if (host) derivedHosts.push(host);
    } catch {
      // Invalid URL — skip host derivation.
    }
  } else if (definitionBaseUrlTemplate) {
    // Template host carries {var} placeholders; derive the literal-host pattern
    // (e.g. *.atlassian.net). The per-call resolved host is still enforced
    // against allowedHosts at execution time — this is only the create default.
    const host = deriveHostFromBaseUrlTemplate(definitionBaseUrlTemplate);
    if (host) derivedHosts.push(host);
  }

  // Merge suggestedEgressPolicy from definition author as defaults.
  // Explicit binding values always win over suggestions.
  const suggested = suggestedEgressPolicy ?? {};
  const suggestedAdditionalHosts = suggested.additionalHosts ?? [];

  const explicitEgress = rawEgressPolicy ?? {};
  const existingEgress = existingEgressPolicy ?? {};
  const existingStoredHosts = (existingEgress['allowedHosts'] as string[] | undefined) ?? [];

  // Host precedence: explicit input > existing stored > derived (baseUrl ∪ suggested additional).
  // Key presence (not non-emptiness) decides "explicit" — an explicit empty
  // allowedHosts flows through to EgressPolicySchema, which rejects it (min 1) so
  // an invalid narrowing fails loud. Only an OMITTED allowedHosts preserves the
  // stored allowlist, so a partial/credential-only upsert never narrows it.
  const allDerivedHosts = [...new Set([...derivedHosts, ...suggestedAdditionalHosts])];
  const mergedHosts =
    'allowedHosts' in explicitEgress
      ? (explicitEgress['allowedHosts'] as string[])
      : existingStoredHosts.length > 0
        ? existingStoredHosts
        : allDerivedHosts;

  const mergedEgress: Record<string, unknown> = {
    // Suggested defaults are first-create defaults only (lowest priority)
    ...(suggested.allowCrossHostRedirects != null
      ? { allowCrossHostRedirects: suggested.allowCrossHostRedirects }
      : {}),
    ...(suggested.allowedMethods ? { allowedMethods: suggested.allowedMethods } : {}),
    ...(suggested.minResponseBodyBytes
      ? { maxResponseBodyBytes: suggested.minResponseBodyBytes }
      : {}),
    ...(suggested.minTimeoutMs ? { timeoutMs: suggested.minTimeoutMs } : {}),
    // Stored egress preserved on update (overrides suggested defaults)
    ...existingEgress,
    // Explicit binding input wins over everything
    ...explicitEgress,
    // Hosts are special — merged separately above
    allowedHosts: mergedHosts,
  };

  const egressResult = EgressPolicySchema.safeParse(mergedEgress);
  if (!egressResult.success) {
    const issues = egressResult.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(
      `Invalid egress policy: ${issues}. ` +
        'Ensure at least one allowedHost is configured (usually auto-derived from baseUrl).',
    );
  }

  return { auth: authResult.data, egressPolicy: egressResult.data };
}

export const ApiDefinitionSummarySchema = z.object({
  apiId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  version: z.string(),
  baseUrlTemplate: z.string().optional(),
  variables: z
    .array(ApiVariableSchema)
    .optional()
    .describe(
      'NON-SECRET per-binding variables a binding must fill (subdomain/region/account-id). ' +
        'Surfaced so a caller/operator can see which variables a binding needs and why it ' +
        'may be "needs configuration".',
    ),
  endpoints: z.array(
    z.object({
      endpointId: z.string(),
      name: z.string(),
      description: z.string().optional(),
      method: HttpMethodSchema,
      pathTemplate: z.string(),
      params: z.array(EndpointParamSchema),
      bodyEncoding: BodyEncodingSchema.optional(),
      tags: z.array(z.string()).default([]),
    }),
  ),
  tags: z.array(z.string()),
});
export type ApiDefinitionSummary = z.infer<typeof ApiDefinitionSummarySchema>;
