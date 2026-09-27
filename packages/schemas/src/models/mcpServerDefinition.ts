import { z } from 'zod';
import { IconRefSchema } from '../store/iconRef.js';

// ============================================================================
// MCP Transport
// ============================================================================

/**
 * MCP transport protocol. Streamable HTTP is the canonical remote transport
 * as of spec rev 2025-11-25; legacy HTTP+SSE was deprecated in 2025-03-26 and
 * is not supported.
 */
export const McpTransportSchema = z.enum(['streamable_http']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

// ============================================================================
// Tool Filter (definition-level tool curation + governance)
// ============================================================================

export const McpToolFilterSchema = z.object({
  /**
   * The allowlist, and the whole of what a remote server may be called for:
   * an absent or empty `include` exposes nothing. A server reachable over the
   * network earns each tool explicitly, so a definition saved before its tools
   * were curated calls none of them rather than all of them.
   */
  include: z.array(z.string().max(256)).max(200).optional(),
  /** Exclude these tools (blocklist). Applied after include. */
  exclude: z.array(z.string().max(256)).max(200).optional(),
  opTaskOnly: z.array(z.string().max(256)).max(200).optional(),
});
export type McpToolFilter = z.infer<typeof McpToolFilterSchema>;

// ============================================================================
// MCP Server Definition (catalog entry — no secrets, no cached tools)
// ============================================================================

export const McpServerDefinitionSchema = z.object({
  /** Stable server identifier (e.g., "kaggle", "github-mcp", "slack") */
  serverId: z.string().max(128),
  /** Human-readable name */
  name: z.string().max(256),
  /** Description (shown to agents in catalog context) */
  description: z.string().max(2000).optional(),
  /** MCP server URL */
  serverUrl: z.string().url().max(2048),
  /** Transport protocol. Streamable HTTP is the only supported transport. */
  transport: McpTransportSchema.default('streamable_http'),
  /**
   * Tool filter — restrict which tools from the server are exposed at all.
   * Acts as the definition-level security boundary. Applied on top of the
   * binding's cached tool list at read time.
   */
  toolFilter: McpToolFilterSchema.optional(),
  /**
   * Override path for OAuth 2.0 Protected Resource Metadata discovery (RFC 9728).
   * Default: '/.well-known/oauth-protected-resource' (root well-known).
   * Only consulted for the root well-known PRM discovery path; the path-specific
   * fallback and `WWW-Authenticate` paths always use the spec-defined locations.
   */
  protectedResourceMetadataPath: z.string().max(512).optional(),
  /**
   * Spec compatibility hint — MCP protocol version observed on the last
   * successful handshake. Surfaced to operators; not load-bearing.
   */
  observedProtocolVersion: z.string().max(32).optional(),
  icon: IconRefSchema.optional().describe(
    'How this server is identified visually. Set explicitly, it wins over the curated ' +
      'icon the platform ships for well-known ids. Absent, the UI renders a ' +
      'deterministic initials tile; artwork is never required.',
  ),
  /** Tags for categorization */
  tags: z.array(z.string().max(64)).max(20).default([]),
  source: z.enum(['platform', 'custom', 'discovered', 'bundle']).default('custom'),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type McpServerDefinition = z.infer<typeof McpServerDefinitionSchema>;

// ============================================================================
// MCP Auth Profiles (stored in Bindings, never visible to agents)
// ============================================================================

export const McpAuthTypeSchema = z.enum([
  'none',
  'bearer',
  'header',
  'oauth2_client_credentials',
  'oauth2_pkce',
  'oauth2_cimd',
]);
export type McpAuthType = z.infer<typeof McpAuthTypeSchema>;

export const McpAuthProfileSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),

  z.object({
    type: z.literal('bearer'),
    /** Credential key referencing api_credentials table. Optional during install; required at enable time. */
    credentialKey: z.string().max(256).optional(),
  }),

  z.object({
    type: z.literal('header'),
    /** Custom header name (e.g., "X-API-Key") */
    headerName: z.string().max(128),
    credentialKey: z.string().max(256).optional(),
  }),

  z.object({
    type: z.literal('oauth2_client_credentials'),
    /** OAuth 2.0 token endpoint */
    tokenEndpoint: z.string().url().max(2048),
    clientIdCredentialKey: z.string().max(256).optional(),
    clientSecretCredentialKey: z.string().max(256).optional(),
    scopes: z.array(z.string().max(128)).optional(),
  }),

  // OAuth 2.1 + PKCE, traditional pre-registered client_id.
  z.object({
    type: z.literal('oauth2_pkce'),
    /**
     * Authorization Server endpoint. If omitted, discovered via PRM
     * (Protected Resource Metadata, RFC 9728).
     */
    authorizationServer: z.string().url().max(2048).optional(),
    // Inert: client resolution for consent-based flows is driven entirely by
    // binding.clientScope (platform CIMD doc URL, or a per-space oauth_clients
    // row), never these keys. Retained until the Phase 4 binding-editor migrates
    // pre-registered clients into oauth_clients.
    clientIdCredentialKey: z.string().max(256).optional(),
    clientSecretCredentialKey: z.string().max(256).optional(),
    scopes: z.array(z.string().max(128)).optional(),
    /** RFC 8707 audience parameter. Defaults to definition.serverUrl. */
    resource: z.string().url().max(2048).optional(),
  }),

  // OAuth 2.1 + PKCE with Client ID Metadata Document (SEP-991). No DCR.
  z.object({
    type: z.literal('oauth2_cimd'),
    authorizationServer: z.string().url().max(2048).optional(),
    /**
     * URL of the hosted CIMD JSON. Phoenix hosts a platform-global document
     * at `https://api.aflow.ai/.well-known/cimd`.
     */
    clientIdMetadataUrl: z.string().url().max(2048),
    scopes: z.array(z.string().max(128)).optional(),
    resource: z.string().url().max(2048).optional(),
  }),
]);
export type McpAuthProfile = z.infer<typeof McpAuthProfileSchema>;

// ============================================================================
// Cached MCP Tool Schema (from tools/list response)
// ============================================================================

export const McpCachedToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).optional(),
});
export type McpCachedTool = z.infer<typeof McpCachedToolSchema>;

// ============================================================================
// MCP Connection Policy
// ============================================================================

export const McpConnectionPolicySchema = z.object({
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  /** Max response size from any single tool call. Default: 10 MB. */
  maxResponseBytes: z.number().int().positive().max(524_288_000).default(10_485_760),
  /**
   * Max LLM tokens permitted per `sampling/createMessage` request from this
   * server. Enforced when binding.samplingPolicy is `'no_tools'` or `'full'`.
   */
  maxSamplingTokens: z.number().int().positive().max(200_000).default(4_096),
  /**
   * Max recursive depth for sampling-with-tools: a sampling request whose tool
   * calls trigger another sampling request stacks. Counted on the parent
   * `mcp.tool.call`; exceeding the cap fails with `sampling_depth_exceeded`.
   */
  maxSamplingDepth: z.number().int().nonnegative().max(8).default(1),
  /**
   * Lease TTL for paused MCP tool calls awaiting elicitation response.
   * Exceeded → executor sends `elicitation/cancel` and fails the step with
   * `elicitation_timeout`.
   */
  elicitationLeaseMs: z.number().int().positive().max(3_600_000).default(900_000),
});
export type McpConnectionPolicy = z.infer<typeof McpConnectionPolicySchema>;

// ============================================================================
// Session metadata (negotiated from last successful connect)
// ============================================================================

export const McpSessionMetadataSchema = z.object({
  protocolVersion: z.string().max(32).optional(),
  serverInfo: z.record(z.unknown()).optional(),
  capabilities: z.record(z.unknown()).optional(),
});
export type McpSessionMetadata = z.infer<typeof McpSessionMetadataSchema>;

// ============================================================================
// MCP Server Binding (credentials + governance + tool cache)
// ============================================================================

/**
 * Sampling policy for server-initiated `sampling/createMessage` requests.
 *   'off'       — reject all sampling requests
 *   'no_tools'  — accept sampling but strip server-requested tools/toolChoice
 *   'full'      — accept full sampling-with-tools (server may request tool calls
 *                 inside its sub-loop; resolved against the binding's ACL)
 */
export const McpSamplingPolicySchema = z.enum(['off', 'no_tools', 'full']);
export type McpSamplingPolicy = z.infer<typeof McpSamplingPolicySchema>;

export const McpServerBindingSchema = z.object({
  bindingId: z.string().max(128),
  serverId: z.string().max(128),
  name: z.string().max(256),
  description: z.string().max(2000).optional(),
  scope: z.object({
    tenantId: z.string(),
    spaceId: z.string().optional(),
    flowId: z.string().optional(),
  }),
  auth: McpAuthProfileSchema,
  /** Connection policy (timeouts, sampling budgets, elicitation lease). */
  connectionPolicy: McpConnectionPolicySchema.default({}),
  /**
   * Pinned server URL origin, recorded at successful connect.
   *
   * For bindings with `auth.type !== 'none'`, the pin MUST exist before the
   * binding can be enabled or invoked — `mcp.binding.upsert` rejects
   * `enabled: true` without a pin, and the executor rejects calls with
   * `error: 'origin_not_pinned'`. The operational flow is
   * `upsert (enabled: false) → mcp.binding.test (pins origin + populates cache)
   * → flip enabled to true`.
   *
   * For `auth.type: 'none'`, the executor records the origin from the first
   * successful handshake (no credentials to exfiltrate).
   *
   * Format: URL origin (scheme + host + port), e.g., "https://www.kaggle.com".
   */
  pinnedOrigin: z.string().max(2048).optional(),
  /**
   * Cached tool schemas from the last successful tools/list call WITH THIS
   * BINDING'S CREDENTIALS. Binding-scoped because MCP servers may return
   * different tool lists depending on the auth token.
   *
   * Updated by: mcp.binding.test, mcp.server.refresh_tools, list_changed push.
   * Consumed by: buildAvailableTools() for agent turn tool declarations.
   */
  cachedTools: z.array(McpCachedToolSchema).optional(),
  /** When cachedTools was last refreshed */
  cachedToolsAt: z.string().datetime().optional(),
  /**
   * Subscribe to `notifications/tools/list_changed` on the warm MCP session.
   * When true, the executor maintains the session and writes fresh `cachedTools`
   * to DB on every notification, replacing the polling stale check.
   */
  subscribeListChanged: z.boolean().default(true),
  /** Sampling policy for server-initiated sampling/createMessage requests. */
  samplingPolicy: McpSamplingPolicySchema.default('off'),
  /** Identity axis — whose OAuth tokens this binding replays at call time. */
  ownerScope: z.enum(['user', 'space']).default('space'),
  /** Client axis — whose registered OAuth app drives consent/token exchange. */
  clientScope: z.enum(['platform', 'tenant', 'space']).default('platform'),
  /** Negotiated session metadata from the last successful connect. */
  sessionMetadata: McpSessionMetadataSchema.optional(),
  enabled: z.boolean().default(true),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type McpServerBinding = z.infer<typeof McpServerBindingSchema>;

// ============================================================================
// Helpers
// ============================================================================

export function applyToolFilter(
  tools: McpCachedTool[],
  filter: McpToolFilter | undefined,
): McpCachedTool[] {
  if (!filter?.include || filter.include.length === 0) {
    return [];
  }

  let filtered = tools;
  const includeSet = new Set(filter.include);
  filtered = filtered.filter((t) => includeSet.has(t.name));

  if (filter.exclude && filter.exclude.length > 0) {
    const excludeSet = new Set(filter.exclude);
    filtered = filtered.filter((t) => !excludeSet.has(t.name));
  }

  return filtered;
}

export function toolOpTaskOnly(toolName: string, filter: McpToolFilter | undefined): boolean {
  if (!filter?.opTaskOnly) return false;
  return filter.opTaskOnly.includes(toolName);
}

/**
 * Extract the origin (scheme + host + port) from a URL.
 * Used for origin pinning on bindings.
 */
export function extractUrlOrigin(url: string): string {
  const parsed = new URL(url);
  return parsed.origin;
}

// ============================================================================
// Cache lifecycle policy
// ============================================================================

export const MCP_TOOLS_STALE_AFTER_MS = 60 * 60 * 1000;

// ============================================================================

/**
 * Phoenix-side representation of an MCP `elicitation/create` request.
 *
 * Mirrors the union of `ElicitRequestFormParamsSchema` and
 * `ElicitRequestURLParamsSchema` from `@modelcontextprotocol/sdk`, lifted
 * into a single shape so the orchestrator + UI + lease store can all carry
 * one envelope. The SDK's request handler receives one of the union arms
 * and the executor normalizes into this shape before publishing the
 * `mcp_elicitation_request` event.
 *
 * Modes:
 *   - `form` — server requests structured data via `requestedSchema`.
 *     The user fills a UI form; we send the validated answer back as
 *     `ElicitResult.content`.
 *   - `url` — server hands us an out-of-band URL (e.g. an OAuth pre-auth
 *     page or a payment confirmation). The MCP client never sees the
 *     credentials; we just relay accept/decline once the user finishes
 *     in-browser.
 */
export const McpElicitationRequestSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('form'),
    /** Server-supplied elicitation identifier (correlates response). */
    elicitationId: z.string().max(256),
    /** Human prompt to render above the form. */
    message: z.string().max(4_000),
    /**
     * JSON Schema (`type: 'object'`) describing the expected response
     * content. Stored as-is so the UI can render via existing JSON-Schema
     * form renderers; validated against on the server side before forward.
     */
    requestedSchema: z.record(z.unknown()),
    /** Optional TTL hint from the server (`task.ttl`); ms. */
    ttlMs: z.number().int().positive().max(86_400_000).optional(),
  }),
  z.object({
    mode: z.literal('url'),
    elicitationId: z.string().max(256),
    message: z.string().max(4_000),
    /**
     * Out-of-band URL the user opens in their browser. Rendered as a
     * clickable link from a remote server's payload, so non-https schemes
     * are rejected at parse (http only for loopback dev servers).
     */
    url: z
      .string()
      .url()
      .max(8_192)
      .refine(
        (value) => {
          let parsed: URL;
          try {
            parsed = new URL(value);
          } catch {
            return false;
          }
          if (parsed.protocol === 'https:') return true;
          return (
            parsed.protocol === 'http:' &&
            (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
          );
        },
        {
          message: 'Elicitation URLs must be https (http is allowed for localhost only).',
        },
      ),
    ttlMs: z.number().int().positive().max(86_400_000).optional(),
  }),
]);
export type McpElicitationRequest = z.infer<typeof McpElicitationRequestSchema>;

/**
 * Phoenix-side representation of an MCP `ElicitResult` — the user's
 * response to an elicitation request.
 *
 * `accept` carries `content` (form mode) or no body (URL mode confirming).
 * `decline` and `cancel` carry no content. The orchestrator publishes one
 * of these on `mcpElicitationResponseChannel`; the leaseholder executor
 * resolves its suspended request handler with this value, which the MCP
 * SDK then ships to the server as the elicitation response.
 */
export const McpElicitationResponseSchema = z.object({
  elicitationId: z.string().max(256),
  action: z.enum(['accept', 'decline', 'cancel']),
  /** Validated response content for form-mode `accept`. */
  content: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
  /**
   * Tenant assertion — set by the orchestrator when publishing the
   * response so the executor can reject cross-tenant deliveries even
   * though the channel is keyed only by elicitationId. Optional for
   * backwards-compat with legacy publishers; the executor warns on
   * mismatch and ignores the message.
   */
  tenantId: z.string().max(128).optional(),
});
export type McpElicitationResponse = z.infer<typeof McpElicitationResponseSchema>;

/**
 * Lease record — written to `mcpElicitationLeaseKey(elicitationId)` while
 * the executor is suspended waiting on this elicitation. Lets the
 * orchestrator's response router and the boot-time reconciler identify
 * which executor instance owns the warm session.
 */
export const McpElicitationLeaseSchema = z.object({
  elicitationId: z.string().max(256),
  /** Stable consumer name of the holder (matches executor heartbeat). */
  executorInstanceId: z.string().max(256),
  stepExecutionId: z.string().max(256),
  tenantId: z.string().max(128),
  bindingId: z.string().max(128),
  serverId: z.string().max(128),
  /** Empty for workflow-task dispatched calls; correlates SSE for sessions. */
  sessionId: z.string().max(256).optional(),
  /** Wall-clock expiry (ISO string). Mirrors the Redis TTL. */
  leaseExpiresAt: z.string().datetime(),
  /** When acquired (ISO). */
  acquiredAt: z.string().datetime(),
});
export type McpElicitationLease = z.infer<typeof McpElicitationLeaseSchema>;

/**
 * Error code constants for elicitation failure paths. Stable strings so
 * the orchestrator's failure classifier, the UI, and operator alerts can
 * agree on what each terminal state means.
 *
 *   - `elicitation_executor_lost` (retryable): the lease expired or the
 *     holder instance is dead. The warm session can't be reused; a future
 *     re-run starts over.
 *   - `elicitation_timeout` (terminal): the lease's wall-clock TTL elapsed
 *     before the user responded. Executor sends `elicitation/cancel` to
 *     the server and fails the call.
 *   - `elicitation_response_invalid` (validation): the orchestrator
 *     received a response whose `content` did not satisfy the original
 *     `requestedSchema`. UI bug or hostile resume payload.
 */
export const MCP_ELICITATION_ERROR_CODES = {
  EXECUTOR_LOST: 'elicitation_executor_lost',
  TIMEOUT: 'elicitation_timeout',
  RESPONSE_INVALID: 'elicitation_response_invalid',
} as const;
