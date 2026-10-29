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
import { McpCachedToolSchema } from '../models/mcpServerDefinition.js';
import { McpServerOperationRegistrations } from './mcp/server.js';
import { McpBindingOperationRegistrations } from './mcp/binding.js';

export * from './mcp/server.js';
export * from './mcp/binding.js';

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

/**
 * The `mcp.*` operations the MCP executor runs — the ones that open a
 * session to the server. Every other `mcp.*` operation an agent can call runs
 * inline in the orchestrator; a contract test there holds the two together.
 */
export const MCP_EXECUTOR_OPERATION_IDS: readonly string[] = [
  'mcp.tool.call',
  'mcp.tool.list',
  'mcp.binding.test',
  'mcp.server.refresh_tools',
];

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
    agentAlternative:
      "Call the tool directly instead: catalog.tool.search finds the bound server's tools, catalog.tool.promote adds them, then call each by its callName.",
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
  ...McpServerOperationRegistrations,
  ...McpBindingOperationRegistrations,

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
