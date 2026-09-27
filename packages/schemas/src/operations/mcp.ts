/**
 * MCP (Model Context Protocol) step operation schemas.
 *
 * Enables flows to call tools on external MCP servers.
 * The executor connects to the configured MCP server, discovers tools,
 * and invokes the specified tool with the provided arguments.
 *
 * @see https://modelcontextprotocol.io/
 */
import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import {
  McpServerDefinitionSchema,
  McpServerBindingSchema,
  McpCachedToolSchema,
  McpSessionMetadataSchema,
} from '../models/mcpServerDefinition.js';

// ============================================================================
// mcp.tool.call — Call a tool on an MCP server
// ============================================================================

export const McpToolCallManagedInputSchema = z.object({
  /** MCP server definition ID — executor resolves URL and auth from definition + binding */
  serverId: z.string().max(128).describe('MCP server definition ID'),
  /** Tool name to invoke */
  toolName: z.string().max(256).describe('Tool name as advertised by the MCP server'),
  /** Tool arguments (JSON object) */
  arguments: z
    .record(z.unknown())
    .describe("Tool call arguments — must match the tool's input schema")
    .optional(),
  bindingId: z
    .string()
    .max(128)
    .describe('Optional binding ID hint from task capability grants')
    .optional(),
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(300_000)
    .describe('Request timeout in milliseconds')
    .optional(),
});
export type McpToolCallManagedInput = z.infer<typeof McpToolCallManagedInputSchema>;

/**
 * Raw path — direct serverUrl (dev / smoke-test only; not for production use).
 * Production callers should configure a managed binding and use the serverId path.
 */
export const McpToolCallRawInputSchema = z.object({
  /** MCP server URL (Streamable HTTP transport only — SSE is not supported). */
  serverUrl: z.string().url().max(2048).describe('MCP server endpoint URL (Streamable HTTP)'),
  /** Tool name to invoke */
  toolName: z.string().max(256).describe('Tool name as advertised by the MCP server'),
  /** Tool arguments (JSON object) */
  arguments: z
    .record(z.unknown())
    .describe("Tool call arguments — must match the tool's input schema")
    .optional(),
  /** Optional API key or bearer token for authenticating with the MCP server */
  authToken: z.string().max(4096).describe('Bearer token for MCP server authentication').optional(),
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(300_000)
    .describe('Request timeout in milliseconds')
    .optional(),
});
export type McpToolCallRawInput = z.infer<typeof McpToolCallRawInputSchema>;

export const McpToolCallInputSchema = z.union([
  McpToolCallManagedInputSchema,
  McpToolCallRawInputSchema,
]);
export type McpToolCallInput = z.infer<typeof McpToolCallInputSchema>;

export const McpToolCallOutputSchema = z.object({
  /** Tool call result content (array of content blocks) */
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      data: z.string().optional(),
      mimeType: z.string().optional(),
    }),
  ),
  /** Whether the tool indicated an error */
  isError: z.boolean().optional(),
  structuredContent: z.record(z.unknown()).optional(),
});
export type McpToolCallOutput = z.infer<typeof McpToolCallOutputSchema>;

// ============================================================================
// mcp.tool.list — List available tools on an MCP server
// ============================================================================

export const McpToolListInputSchema = z.object({
  /** MCP server URL */
  serverUrl: z.string().url().max(2048).describe('MCP server endpoint URL'),
  /** Optional API key or bearer token */
  authToken: z.string().max(4096).describe('Bearer token for MCP server authentication').optional(),
});
export type McpToolListInput = z.infer<typeof McpToolListInputSchema>;

export const McpToolListOutputSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.record(z.unknown()).optional(),
    }),
  ),
});
export type McpToolListOutput = z.infer<typeof McpToolListOutputSchema>;

// ============================================================================

/** Upsert input: definition shape minus auto-populated timestamps, plus owning space. */
export const McpServerUpsertInputSchema = McpServerDefinitionSchema.omit({
  createdAt: true,
  updatedAt: true,
}).extend({
  /** Space that owns this definition. */
  spaceId: z.string().uuid().describe('Owning space ID'),
});
export type McpServerUpsertInput = z.infer<typeof McpServerUpsertInputSchema>;

export const McpServerUpsertOutputSchema = z.object({
  serverId: z.string(),
  spaceId: z.string().uuid(),
  created: z.boolean().describe('True if the row was newly created; false if updated'),
});
export type McpServerUpsertOutput = z.infer<typeof McpServerUpsertOutputSchema>;

export const McpServerGetInputSchema = z.object({
  serverId: z.string().max(128),
  spaceId: z.string().uuid(),
});
export type McpServerGetInput = z.infer<typeof McpServerGetInputSchema>;

export const McpServerGetOutputSchema = z.object({
  definition: McpServerDefinitionSchema.nullable(),
});
export type McpServerGetOutput = z.infer<typeof McpServerGetOutputSchema>;

export const McpServerListInputSchema = z.object({
  /** Filter by space; omit to list across all spaces in tenant. */
  spaceId: z.string().uuid().optional(),
  /** Filter by source (platform/custom/discovered/bundle). */
  source: z.enum(['platform', 'custom', 'discovered', 'bundle']).optional(),
  /** Filter by enabled status. */
  enabled: z.boolean().optional(),
});
export type McpServerListInput = z.infer<typeof McpServerListInputSchema>;

export const McpServerListOutputSchema = z.object({
  definitions: z.array(McpServerDefinitionSchema),
});
export type McpServerListOutput = z.infer<typeof McpServerListOutputSchema>;

export const McpServerDeleteInputSchema = z.object({
  serverId: z.string().max(128),
  spaceId: z.string().uuid(),
});
export type McpServerDeleteInput = z.infer<typeof McpServerDeleteInputSchema>;

export const McpServerDeleteOutputSchema = z.object({
  deleted: z.boolean(),
});
export type McpServerDeleteOutput = z.infer<typeof McpServerDeleteOutputSchema>;

/**
 * Connect with a binding's auth and refresh that binding's cached tool list +
 * pinned origin + session metadata. Routed through the MCP executor.
 */
export const McpServerRefreshToolsInputSchema = z.object({
  serverId: z.string().max(128),
  /** Binding to authenticate with; auth determines what tools the server returns. */
  bindingId: z.string().max(128),
});
export type McpServerRefreshToolsInput = z.infer<typeof McpServerRefreshToolsInputSchema>;

export const McpServerRefreshToolsOutputSchema = z.object({
  serverId: z.string(),
  bindingId: z.string(),
  tools: z.array(McpCachedToolSchema),
  pinnedOrigin: z.string(),
  sessionMetadata: McpSessionMetadataSchema,
  cachedToolsAt: z.string().datetime(),
});
export type McpServerRefreshToolsOutput = z.infer<typeof McpServerRefreshToolsOutputSchema>;

// ============================================================================

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
});
export type McpBindingUpsertInput = z.infer<typeof McpBindingUpsertInputSchema>;

export const McpBindingUpsertOutputSchema = z.object({
  bindingId: z.string(),
  created: z.boolean(),
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

// ============================================================================
// mcp.tool.discover + mcp.tool.promote — Phase 3 hybrid discovery
// ============================================================================

/**
 * Agent-callable Tier C: list available tools on a bound MCP server.
 *
 * Read-only. Returns the binding's current `cachedTools` from DB. If
 * `cachedToolsAt` is stale (older than the orchestrator's TTL), the response
 * includes a `stale: true` hint and the agent should call
 * `mcp.server.refresh_tools` before relying on the list. Access is gated by
 * the agent's scope: serverId must appear in `catalog.coreMcpServers`,
 * `catalog.discovery.allowedMcpServerIds`, or a task capability grant.
 */
export const McpToolDiscoverInputSchema = z.object({
  serverId: z.string().max(128).describe('MCP server definition ID'),
});
export type McpToolDiscoverInput = z.infer<typeof McpToolDiscoverInputSchema>;

export const McpToolDiscoverOutputSchema = z.object({
  serverId: z.string(),
  bindingId: z.string(),
  /** Tools surviving the definition's `toolFilter` (include/exclude). */
  tools: z.array(McpCachedToolSchema),
  /** When the binding's cache was last refreshed (ISO 8601). */
  cachedToolsAt: z.string().datetime().nullable(),
  /** True when the cache is older than the discovery freshness window. */
  stale: z.boolean(),
});
export type McpToolDiscoverOutput = z.infer<typeof McpToolDiscoverOutputSchema>;

export const McpToolPromoteInputSchema = z.object({
  serverId: z.string().max(128).describe('MCP server definition ID'),
  toolNames: z
    .array(z.string().max(256))
    .min(1)
    .max(50)
    .describe('Tool names to promote — must appear in binding.cachedTools'),
});
export type McpToolPromoteInput = z.infer<typeof McpToolPromoteInputSchema>;

export const McpToolPromoteOutputSchema = z.object({
  serverId: z.string(),
  bindingId: z.string(),
  promoted: z.array(z.string()),
  rejected: z.array(
    z.object({
      name: z.string(),
      reason: z.string(),
    }),
  ),
});
export type McpToolPromoteOutput = z.infer<typeof McpToolPromoteOutputSchema>;

// ============================================================================
// Registration
// ============================================================================

export const McpOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'mcp',
    group: 'tool',
    verb: 'call',
    name: 'Call MCP Tool',
    actionLabel: 'Calling MCP tool…',
    semanticDescription:
      'Invoke a tool on an external MCP (Model Context Protocol) server. ' +
      'Connects to the server, discovers available tools, and calls the specified tool with arguments.',
    tags: ['mcp', 'tool', 'integration', 'interop'],
    idempotency: 'unknown',
    usage: {
      oneLine: 'Call a tool on an MCP server',
      whenToUse: [
        'When you need to invoke a tool exposed by an external MCP server',
        'When integrating with third-party AI tool providers',
        'When using MCP as the tool access protocol for external services',
      ],
      whenNotToUse: [
        'For direct HTTP API calls — use api.http.call instead',
        'For tools already available as built-in Phoenix operations',
      ],
      pitfalls: [
        'Ensure the MCP server URL is reachable from the executor',
        'Tool arguments must match the schema advertised by the MCP server',
        'authToken is sent as-is — configure server-side credential resolution for production',
      ],
      minimalExampleInput: {
        serverUrl: 'https://mcp.example.com/mcp',
        toolName: 'search_docs',
        arguments: { query: 'How to configure auth?' },
      },
    },
    accessMode: 'write',
    riskModifiers: ['external_side_effect'],
    inputZod: McpToolCallInputSchema,
    outputZod: McpToolCallOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'tool',
    verb: 'list',
    name: 'List MCP Tools',
    actionLabel: 'Listing MCP tools…',
    semanticDescription:
      'Discover available tools on an MCP server. Returns tool names, descriptions, and input schemas.',
    tags: ['mcp', 'tool', 'discovery'],
    idempotency: 'idempotent',
    usage: {
      oneLine: 'List tools available on an MCP server',
      whenToUse: [
        'When you need to discover what tools an MCP server offers',
        'Before calling mcp.tool.call to verify tool availability',
      ],
      whenNotToUse: ['When you already know the tool name and schema'],
      pitfalls: ['Large tool catalogs may return many results'],
      minimalExampleInput: {
        serverUrl: 'https://mcp.example.com/mcp',
      },
    },
    accessMode: 'read',
    inputZod: McpToolListInputSchema,
    outputZod: McpToolListOutputSchema,
  },

  // --------------------------------------------------------------------------
  // mcp.server.* — definition CRUD
  // --------------------------------------------------------------------------
  {
    stepType: 'mcp',
    group: 'server',
    verb: 'upsert',
    name: 'Upsert MCP Server Definition',
    actionLabel: 'Saving MCP server definition…',
    semanticDescription:
      'Create or update an MCP server definition (serverId, URL, transport, toolFilter, PRM hints). ' +
      'Definitions hold no credentials — pair with a binding to authorize access.',
    tags: ['crud', 'mcp', 'integration'],
    crudView: { entityType: 'mcp_server_definition', action: 'create' },
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine:
        'Register an MCP server definition. After this: create a binding (mcp.binding.upsert) to ' +
        'configure auth, then run mcp.binding.test to populate cache + origin pin.',
      whenToUse: [
        'Registering a new external MCP server for use by agents',
        'Updating tool filter, PRM path, or tags on an existing definition',
      ],
      whenNotToUse: [
        'Changing auth credentials — that is on the binding, not the definition',
        'Calling tools — use mcp.tool.call via a promoted binding',
      ],
      pitfalls: [
        'Definitions are space-scoped via (serverId, spaceId) composite key — same serverId can ' +
          'live in multiple spaces independently.',
        'Streamable HTTP is the only supported transport per spec rev 2025-11-25.',
      ],
      minimalExampleInput: {
        serverId: 'example-mcp',
        name: 'Example MCP',
        serverUrl: 'https://mcp.example.com/mcp',
        transport: 'streamable_http',
        spaceId: '00000000-0000-0000-0000-000000000000',
      },
      followUp: [
        {
          operationId: 'mcp.binding.upsert',
          note: 'Create a binding to configure credentials and policy',
          condition: 'when_available',
        },
      ],
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: McpServerUpsertInputSchema,
    outputZod: McpServerUpsertOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'server',
    verb: 'get',
    name: 'Get MCP Server Definition',
    actionLabel: 'Loading MCP server…',
    semanticDescription: 'Load a single MCP server definition by (serverId, spaceId).',
    tags: ['crud', 'mcp'],
    crudView: { entityType: 'mcp_server_definition', action: 'read' },
    idempotency: 'idempotent',
    usage: {
      oneLine: 'Get an MCP server definition by id.',
      whenToUse: ['Inspecting a definition before editing or wiring a binding to it'],
      whenNotToUse: ['Listing many definitions — use mcp.server.list'],
      pitfalls: [],
      minimalExampleInput: {
        serverId: 'kaggle',
        spaceId: '00000000-0000-0000-0000-000000000000',
      },
    },
    accessMode: 'read',
    inputZod: McpServerGetInputSchema,
    outputZod: McpServerGetOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'server',
    verb: 'list',
    name: 'List MCP Server Definitions',
    actionLabel: 'Listing MCP servers…',
    semanticDescription:
      'List MCP server definitions in the tenant, optionally filtered by space, source, or enabled status.',
    tags: ['crud', 'mcp'],
    crudView: { entityType: 'mcp_server_definition', action: 'read' },
    idempotency: 'idempotent',
    usage: {
      oneLine: 'List MCP server definitions in this tenant.',
      whenToUse: ['Browsing available MCP servers', 'Auditing platform vs custom installs'],
      whenNotToUse: ['Looking up a single known definition — use mcp.server.get'],
      pitfalls: [],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: McpServerListInputSchema,
    outputZod: McpServerListOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'server',
    verb: 'delete',
    name: 'Delete MCP Server Definition',
    actionLabel: 'Deleting MCP server…',
    semanticDescription:
      'Delete an MCP server definition. Bindings referencing this definition become orphaned ' +
      '— delete them first or repoint to a new definition.',
    tags: ['crud', 'mcp'],
    crudView: { entityType: 'mcp_server_definition', action: 'delete' },
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Delete an MCP server definition.',
      whenToUse: ['Removing a server that is no longer needed'],
      whenNotToUse: ['Disabling temporarily — set enabled: false on the binding instead'],
      pitfalls: [
        'Bindings referencing the deleted definition will fail with definition_not_found.',
      ],
      minimalExampleInput: {
        serverId: 'example-mcp',
        spaceId: '00000000-0000-0000-0000-000000000000',
      },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: McpServerDeleteInputSchema,
    outputZod: McpServerDeleteOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'server',
    verb: 'refresh_tools',
    name: 'Refresh MCP Server Tools',
    actionLabel: 'Refreshing MCP server tools…',
    semanticDescription:
      'Connect to the MCP server using the specified binding, call tools/list, and write the result ' +
      'to the binding (cachedTools, cachedToolsAt, pinnedOrigin, sessionMetadata). Routed through the ' +
      'MCP executor.',
    tags: ['mcp', 'discovery', 'cache'],
    privileged: true,
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: "Refresh a binding's tool cache by reconnecting to the server.",
      whenToUse: [
        'After a server adds or renames tools',
        'After credential changes to verify the binding still works',
        'To populate the cache for a newly created binding before enabling it',
      ],
      whenNotToUse: ['As a substitute for mcp.binding.test on first connect'],
      pitfalls: [
        'MCP servers may return different tool lists per credential — refresh is per-binding, not per-definition.',
      ],
      minimalExampleInput: {
        serverId: 'kaggle',
        bindingId: 'kaggle-default',
      },
    },
    accessMode: 'write',
    riskModifiers: ['privileged'],
    inputZod: McpServerRefreshToolsInputSchema,
    outputZod: McpServerRefreshToolsOutputSchema,
  },

  // --------------------------------------------------------------------------
  // mcp.binding.* — binding CRUD
  // --------------------------------------------------------------------------
  {
    stepType: 'mcp',
    group: 'binding',
    verb: 'upsert',
    name: 'Upsert MCP Server Binding',
    actionLabel: 'Saving MCP binding…',
    semanticDescription:
      'Create or update an MCP server binding (auth, scope, ACL, connection + sampling policy). ' +
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
        'Authorizing an MCP server in a specific scope (tenant/space/flow)',
        'Updating ACLs, sampling policy, or connection policy on an existing binding',
      ],
      whenNotToUse: [
        'Updating cached tools or pinned origin — those come from mcp.binding.test, not upsert',
      ],
      pitfalls: [
        'Credentials are referenced by credentialKey only — store actual values via the Integrations page.',
        'Credentialed bindings require mcp.binding.test to populate pinnedOrigin before they can be enabled.',
      ],
      minimalExampleInput: {
        bindingId: 'kaggle-default',
        serverId: 'kaggle',
        name: 'Kaggle Default',
        scope: { tenantId: '00000000-0000-0000-0000-000000000000' },
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

  // --------------------------------------------------------------------------
  // mcp.tool.* — Phase 3 hybrid discovery (agent-callable)
  // --------------------------------------------------------------------------
  {
    stepType: 'mcp',
    group: 'tool',
    verb: 'discover',
    name: 'Discover MCP Tools',
    actionLabel: 'Discovering MCP tools…',
    semanticDescription:
      'List the tools available on a bound MCP server. Read-only; returns the binding cache. ' +
      'Server must be in your scope (coreMcpServers, discovery.allowedMcpServerIds, or a task grant). ' +
      'When the response says `stale: true`, call mcp.server.refresh_tools first, then re-discover.',
    tags: ['mcp', 'discovery', 'catalog'],
    idempotency: 'idempotent',
    usage: {
      oneLine: 'Read the tool list cached for a bound MCP server in your scope.',
      whenToUse: [
        'When you know a server is bound but need to see which specific tools it exposes',
        'Before mcp.tool.promote — to pick the right toolName(s)',
      ],
      whenNotToUse: [
        'For built-in platform operations — use catalog.tool.search',
        'When you already see the tool in the available-tools list — call it directly',
      ],
      pitfalls: [
        'serverId must already be in your scope; this op does NOT install bindings.',
        'A stale cache (>1h) indicates no recent connect; refresh first via mcp.server.refresh_tools.',
        'Tools returned have already passed the definition toolFilter (include/exclude).',
      ],
      minimalExampleInput: { serverId: 'kaggle' },
      followUp: [
        {
          operationId: 'mcp.tool.promote',
          note: 'Promote selected tools into the active session surface',
          condition: 'when_available',
        },
        {
          operationId: 'mcp.server.refresh_tools',
          note: 'Force a live tools/list refresh if the cache is stale',
          condition: 'when_available',
        },
      ],
    },
    accessMode: 'read',
    inputZod: McpToolDiscoverInputSchema,
    outputZod: McpToolDiscoverOutputSchema,
  },
  {
    stepType: 'mcp',
    group: 'tool',
    verb: 'promote',
    name: 'Promote MCP Tools',
    actionLabel: 'Promoting MCP tools…',
    semanticDescription:
      'Add selected discovered MCP tools to your active session surface. ' +
      'Promoted tools become directly callable as `mcp_{serverId}.{toolName}` on subsequent turns. ' +
      'ACL is re-checked; tools failing the binding policy are returned in `rejected[]` with a reason.',
    tags: ['mcp', 'discovery', 'catalog'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Add discovered MCP tools to your active session toolset.',
      whenToUse: [
        'After mcp.tool.discover or catalog.tool.search returned the tool(s) you need',
        'When the tool is bound in your space but not in coreMcpServers',
      ],
      whenNotToUse: [
        'For tools already in your available-tools list — just call them',
        'For platform operations — those are not MCP tools',
      ],
      pitfalls: [
        'Names not in binding.cachedTools are rejected — call mcp.tool.discover first to see valid names.',
        'Tools outside the definition toolFilter (include/exclude) are rejected with a reason.',
        'opTaskOnly tools can be promoted; agents cannot call them directly — use an explicit workflow operation task.',
        "**Scope is YOU only.** This op mutates YOUR current session's toolbox. Promoted tools are callable by you on subsequent turns. They are NOT granted to subagents, Runners inside workflow tasks, or other sessions — a Runner's toolset comes from the skill's task definition, not from any promotion you do.",
      ],
      minimalExampleInput: { serverId: 'kaggle', toolNames: ['search_datasets', 'get_dataset'] },
    },
    accessMode: 'write',
    inputZod: McpToolPromoteInputSchema,
    outputZod: McpToolPromoteOutputSchema,
  },
];
