import { z } from 'zod';
import type { OperationRegistration } from '../../catalog/operationCatalog.js';
import {
  McpServerBindingSchema,
  McpCachedToolSchema,
  McpSessionMetadataSchema,
} from '../../models/mcpServerDefinition.js';
import { RunSpaceIdSchema, UPDATE_KEEPS_OMITTED } from './runSpace.js';

/**
 * Upsert input: binding shape minus auto-populated fields. Server-side validation
 * rejects `enabled: true` on a credentialed binding without `pinnedOrigin` —
 * caller must run `mcp.binding.test` first to populate the pin.
 */
export const McpBindingUpsertInputSchema = McpServerBindingSchema.omit({
  createdAt: true,
  updatedAt: true,
  // Cache + pin populated by mcp.binding.test, never accepted from caller.
  cachedTools: true,
  cachedToolsAt: true,
  pinnedOrigin: true,
  sessionMetadata: true,
})
  .extend({
    // The tenant and space are the run's, stamped by the handler; flowId is
    // the one narrowing the caller owns.
    scope: z
      .object({
        spaceId: RunSpaceIdSchema,
        // Omission is not a statement: an update that leaves flowId out must not
        // widen an operator's flow narrowing to the whole space.
        flowId: z
          .string()
          .min(1, 'flowId must name a flow; pass null to make the binding space-wide')
          .nullable()
          .optional()
          .describe(
            'Narrow the binding to one flow. Omitted: a new binding is space-wide and an existing ' +
              'binding keeps the flow it already has. null: make the binding space-wide, removing ' +
              'any stored flow.',
          ),
      })
      .optional()
      .describe("Optional. The binding is always written to the run's tenant and space."),
    connectionPolicy: McpServerBindingSchema.shape.connectionPolicy.describe(
      'On an existing binding, only the keys given replace the stored ones; the rest keep their ' +
        'stored values. Defaults apply only when creating.',
    ),
    subscribeListChanged: McpServerBindingSchema.shape.subscribeListChanged.describe(
      `Defaults to true on create. ${UPDATE_KEEPS_OMITTED}`,
    ),
    samplingPolicy: McpServerBindingSchema.shape.samplingPolicy.describe(
      `Defaults to 'off' on create. ${UPDATE_KEEPS_OMITTED}`,
    ),
    ownerScope: McpServerBindingSchema.shape.ownerScope.describe(
      `Whose OAuth tokens the binding replays. Defaults to 'space' on create. ${UPDATE_KEEPS_OMITTED}`,
    ),
    clientScope: McpServerBindingSchema.shape.clientScope.describe(
      `Whose OAuth app drives consent. Defaults to 'platform' on create. ${UPDATE_KEEPS_OMITTED}`,
    ),
    enabled: McpServerBindingSchema.shape.enabled.describe(
      'Defaults to true on create. On an existing binding, leaving it out keeps the stored ' +
        'value: a disabled binding stays disabled until enabled: true is sent.',
    ),
  })
  .describe(UPDATE_KEEPS_OMITTED);
export type McpBindingUpsertInput = z.infer<typeof McpBindingUpsertInputSchema>;

export const McpBindingUpsertOutputSchema = z.object({
  bindingId: z.string(),
  created: z.boolean(),
  scope: McpServerBindingSchema.shape.scope.describe(
    'The scope stored after this write. An update that omitted scope.flowId kept the stored ' +
      'flowId, which appears here.',
  ),
  enabled: z
    .boolean()
    .describe(
      'Whether the binding is enabled after this write; an update that omitted it kept it.',
    ),
});
export type McpBindingUpsertOutput = z.infer<typeof McpBindingUpsertOutputSchema>;

export const McpBindingGetInputSchema = z.object({
  bindingId: z.string().max(128),
});
export type McpBindingGetInput = z.infer<typeof McpBindingGetInputSchema>;

export const McpBindingGetOutputSchema = z.object({
  binding: McpServerBindingSchema.nullable(),
});
export type McpBindingGetOutput = z.infer<typeof McpBindingGetOutputSchema>;

export const McpBindingListInputSchema = z.object({
  /** Filter by serverId. */
  serverId: z.string().max(128).optional(),
  /** Filter by space (scope.spaceId). */
  spaceId: z.string().uuid().optional(),
  enabled: z.boolean().optional(),
});
export type McpBindingListInput = z.infer<typeof McpBindingListInputSchema>;

export const McpBindingListOutputSchema = z.object({
  bindings: z.array(McpServerBindingSchema),
});
export type McpBindingListOutput = z.infer<typeof McpBindingListOutputSchema>;

export const McpBindingDeleteInputSchema = z.object({
  bindingId: z.string().max(128),
});
export type McpBindingDeleteInput = z.infer<typeof McpBindingDeleteInputSchema>;

export const McpBindingDeleteOutputSchema = z.object({
  deleted: z.boolean(),
});
export type McpBindingDeleteOutput = z.infer<typeof McpBindingDeleteOutputSchema>;

/**
 * Diagnostic connect: authenticate with this binding's credentials, list tools,
 * and write the result + pinned origin + session metadata back to the binding row.
 * Required before flipping a credentialed binding to `enabled: true`. Routed
 * through the MCP executor.
 */
export const McpBindingTestInputSchema = z.object({
  bindingId: z.string().max(128),
});
export type McpBindingTestInput = z.infer<typeof McpBindingTestInputSchema>;

export const McpBindingTestOutputSchema = z.object({
  bindingId: z.string(),
  serverId: z.string(),
  ok: z.boolean(),
  tools: z.array(McpCachedToolSchema),
  pinnedOrigin: z.string(),
  sessionMetadata: McpSessionMetadataSchema,
  cachedToolsAt: z.string().datetime(),
});
export type McpBindingTestOutput = z.infer<typeof McpBindingTestOutputSchema>;

// ============================================================================
// mcp.binding.consent + mcp.binding.consent.complete — Phase 5 OAuth 2.1 PKCE
// ============================================================================

/**
 * Start an OAuth 2.1 PKCE consent flow for a binding with `auth.type` of
 * `oauth2_pkce` or `oauth2_cimd`. The handler:
 *   1. Discovers PRM + AS metadata for the binding's server.
 *   2. Generates PKCE verifier + challenge (S256).
 *   3. Writes an `oauth_state` row keyed by an opaque `state` token.
 *   4. Returns the authorization URL — the operator UI redirects the user there.
 *
 * Operator-callable only; not in the LLM tool surface.
 */
export const McpBindingConsentInputSchema = z.object({
  bindingId: z.string().max(128),
  // NOTE: The redirect URI is NOT user-supplied. It's a single platform-
  // wide constant (the `/v1/oauth/callback` route) derived server-side
  // from the platform's API_BASE_URL. Caller-controlled redirects would be
  // an open-redirect vector and would diverge from the redirect_uris listed
  // in our hosted CIMD document.
});
export type McpBindingConsentInput = z.infer<typeof McpBindingConsentInputSchema>;

export const McpBindingConsentOutputSchema = z.object({
  bindingId: z.string(),
  /** URL the operator should redirect the user to in their browser. */
  authorizationUrl: z.string().url(),
  /** Opaque state token also embedded in `authorizationUrl`. Surfaced for audit. */
  state: z.string(),
  expiresAt: z.string().datetime(),
});
export type McpBindingConsentOutput = z.infer<typeof McpBindingConsentOutputSchema>;

/**
 * Internal callback handler — invoked by `GET /v1/oauth/callback` after
 * the AS redirects the user back with `?code=...&state=...`. Validates state,
 * exchanges code at the token endpoint (with `resource=` per RFC 8707),
 * encrypts and persists tokens to `oauth_tokens`. Never agent-callable;
 * never operator-callable directly (UI hits the callback route).
 */
export const McpBindingConsentCompleteInputSchema = z.object({
  state: z.string().max(256),
  code: z.string().max(2048),
});
export type McpBindingConsentCompleteInput = z.infer<typeof McpBindingConsentCompleteInputSchema>;

export const McpBindingConsentCompleteOutputSchema = z.object({
  bindingId: z.string(),
  serverId: z.string(),
  ok: z.literal(true),
  /** When the access token expires (ISO 8601). */
  expiresAt: z.string().datetime(),
  /** Scopes the AS actually granted (may differ from request). */
  scopes: z.array(z.string()),
});
export type McpBindingConsentCompleteOutput = z.infer<typeof McpBindingConsentCompleteOutputSchema>;

export const McpBindingOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'mcp',
    group: 'binding',
    verb: 'upsert',
    name: 'Upsert MCP Server Binding',
    actionLabel: 'Saving MCP binding…',
    semanticDescription:
      "Create or update an MCP server binding in the run's space (auth, flow scope, connection + " +
      'sampling policy, owner and client scope, enabled). An update writes only the fields given: ' +
      'every field left out keeps its stored value, and schema defaults apply only when creating. ' +
      'Server rejects enabled: true on a credentialed binding without pinnedOrigin — caller must ' +
      'run mcp.binding.test first.',
    tags: ['crud', 'mcp', 'integration'],
    crudView: { entityType: 'mcp_server_binding', action: 'create' },
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Register an MCP server binding. Flow: upsert (enabled: false) → mcp.binding.test (pins ' +
        'origin + populates cache) → flip enabled to true.',
      whenToUse: [
        "Authorizing an MCP server in the run's space, optionally narrowed to one flow",
        'Updating ACLs, sampling policy, or connection policy on an existing binding',
      ],
      whenNotToUse: [
        'Updating cached tools or pinned origin — those come from mcp.binding.test, not upsert',
      ],
      pitfalls: [
        'Credentials are referenced by credentialKey only — store actual values via the Integrations page.',
        'Credentialed bindings require mcp.binding.test to populate pinnedOrigin before they can be enabled.',
        'bindingId, serverId, name and auth are required on every call, so an update always writes them — resend the stored auth unless you mean to change it.',
        'Every other field left out on an update keeps its stored value: enabled, ownerScope, clientScope, samplingPolicy, subscribeListChanged and description are not reset to their defaults. connectionPolicy merges key by key. To change one, send it.',
        'Updating a binding without scope.flowId keeps its stored flow narrowing; pass scope.flowId: null to make it space-wide. The output scope and enabled are what is stored.',
        "The tenant and space are the run's — there is no tenantId to supply, and a scope.spaceId naming another space is refused.",
      ],
      minimalExampleInput: {
        bindingId: 'kaggle-default',
        serverId: 'kaggle',
        name: 'Kaggle Default',
        auth: { type: 'bearer', credentialKey: 'KAGGLE_MCP_TOKEN' },
        enabled: false,
      },
      followUp: [
        {
          operationId: 'mcp.binding.test',
          note: 'Diagnostic connect to populate origin pin + cached tools',
          condition: 'when_available',
        },
      ],
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: McpBindingUpsertInputSchema,
    outputZod: McpBindingUpsertOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'binding',
    verb: 'get',
    name: 'Get MCP Server Binding',
    actionLabel: 'Loading MCP binding…',
    semanticDescription: 'Load a single MCP server binding by id.',
    tags: ['crud', 'mcp'],
    crudView: { entityType: 'mcp_server_binding', action: 'read' },
    idempotency: 'idempotent',
    usage: {
      oneLine: 'Get an MCP binding by id.',
      whenToUse: ['Inspecting a binding before editing'],
      whenNotToUse: ['Listing many bindings — use mcp.binding.list'],
      pitfalls: [],
      minimalExampleInput: { bindingId: 'kaggle-default' },
    },
    accessMode: 'read',
    inputZod: McpBindingGetInputSchema,
    outputZod: McpBindingGetOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'binding',
    verb: 'list',
    name: 'List MCP Server Bindings',
    actionLabel: 'Listing MCP bindings…',
    semanticDescription:
      'List MCP server bindings in the tenant, optionally filtered by serverId, space, or enabled status.',
    tags: ['crud', 'mcp'],
    crudView: { entityType: 'mcp_server_binding', action: 'read' },
    idempotency: 'idempotent',
    usage: {
      oneLine: 'List MCP bindings in this tenant.',
      whenToUse: ['Browsing configured MCP credentials', 'Auditing enabled vs disabled bindings'],
      whenNotToUse: ['Looking up a single known binding — use mcp.binding.get'],
      pitfalls: [],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: McpBindingListInputSchema,
    outputZod: McpBindingListOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'binding',
    verb: 'delete',
    name: 'Delete MCP Server Binding',
    actionLabel: 'Deleting MCP binding…',
    semanticDescription:
      'Delete an MCP server binding. OAuth tokens are owner-keyed and shared across bindings to the same server (connect-once), so they survive a single binding deletion.',
    tags: ['crud', 'mcp'],
    crudView: { entityType: 'mcp_server_binding', action: 'delete' },
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Delete an MCP binding.',
      whenToUse: ['Removing a binding that is no longer needed'],
      whenNotToUse: ['Temporarily disabling — set enabled: false instead'],
      pitfalls: [
        'OAuth tokens are connect-once (owner-keyed, shared across bindings to the same server) and are not removed by deleting one binding.',
      ],
      minimalExampleInput: { bindingId: 'kaggle-default' },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: McpBindingDeleteInputSchema,
    outputZod: McpBindingDeleteOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'binding',
    verb: 'test',
    name: 'Test MCP Server Binding',
    actionLabel: 'Testing MCP binding…',
    semanticDescription:
      "Diagnostic connect: authenticate with this binding's credentials, call tools/list, and write " +
      'cachedTools, cachedToolsAt, pinnedOrigin, and sessionMetadata back to the binding row. ' +
      'Required prerequisite for enabling any credentialed binding. Routed through the MCP executor.',
    tags: ['mcp', 'diagnostic', 'binding'],
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: "Connect and verify a binding's credentials; populates origin pin and tool cache.",
      whenToUse: [
        'Before enabling a credentialed binding for the first time (required for the pin)',
        'After credential rotation to verify the binding still works',
      ],
      whenNotToUse: ['Calling actual tools — use mcp.tool.call'],
      pitfalls: [
        'Pin is mandatory: credentialed bindings without pinnedOrigin cannot be enabled. Run this op first.',
      ],
      minimalExampleInput: { bindingId: 'kaggle-default' },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: McpBindingTestInputSchema,
    outputZod: McpBindingTestOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'binding',
    verb: 'consent',
    name: 'Start MCP OAuth Consent',
    actionLabel: 'Starting OAuth consent…',
    semanticDescription:
      'Start an OAuth 2.1 + PKCE consent flow for an oauth2_pkce / oauth2_cimd binding. ' +
      'Returns an authorization URL the operator UI redirects the user to. After user consents, ' +
      'the AS calls /v1/oauth/callback which finalizes via mcp.binding.consent.complete. ' +
      'Operator-callable only; not exposed in the LLM tool surface.',
    tags: ['mcp', 'oauth', 'binding'],
    privileged: true,
    idempotency: 'non_idempotent',
    mutates: true,
    agentTool: false,
    usage: {
      oneLine: 'Begin OAuth 2.1 PKCE consent for an MCP binding.',
      whenToUse: [
        'When binding.auth.type is oauth2_pkce or oauth2_cimd and tokens are missing or expired',
      ],
      whenNotToUse: [
        'For bearer/header auth — no consent flow needed; just configure the credential.',
        'For OAuth client-credentials (M2M) bindings — no user consent involved.',
      ],
      pitfalls: [
        'The state token is short-lived (~10 minutes). If the user takes too long, restart consent.',
        'The AS must accept the redirect_uri listed in our CIMD document.',
      ],
      minimalExampleInput: { bindingId: 'notion-personal' },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: McpBindingConsentInputSchema,
    outputZod: McpBindingConsentOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'binding',
    verb: 'consent_complete',
    name: 'Complete MCP OAuth Consent (callback)',
    actionLabel: 'Completing OAuth consent…',
    semanticDescription:
      'Internal callback handler — invoked by GET /v1/oauth/callback after the AS redirects ' +
      'the user back. Validates state, exchanges code for tokens, encrypts + persists to ' +
      'oauth_tokens. Never agent-callable; never operator-callable directly.',
    tags: ['mcp', 'oauth', 'binding', 'internal'],
    internal: true,
    agentTool: false,
    privileged: true,
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'OAuth callback finalization (internal).',
      whenToUse: ['Invoked by /v1/oauth/callback only.'],
      whenNotToUse: ['Never call directly — go through the callback route.'],
      pitfalls: ['state must match a non-expired oauth_state row; code is single-use.'],
      minimalExampleInput: { state: '<opaque>', code: '<auth-code>' },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: McpBindingConsentCompleteInputSchema,
    outputZod: McpBindingConsentCompleteOutputSchema,
  },
];
