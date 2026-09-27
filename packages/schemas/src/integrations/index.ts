import { z } from 'zod';

export * from './connectorCatalog.js';

export const IntegrationSourceKindSchema = z.enum(['api', 'mcp']);
export type IntegrationSourceKind = z.infer<typeof IntegrationSourceKindSchema>;

/**
 * Integration readiness for agent prompts and operator UI.
 *
 * - `bound` — definition + at least one enabled binding with usable credentials.
 *   Tools are callable.
 * - `needs_credentials` — definition + binding exist but credentials are
 *   missing/unpinned/expired. Tools are NOT callable; operator action required.
 * - `disabled` — definition or binding is explicitly disabled. Tools are not
 *   listed; surface in awareness so the operator can re-enable.
 * - `definition-only` — definition installed (e.g., from a bundle) but no
 *   binding has been configured yet. Tools are not callable. Hidden from
 *   `SpaceContext.integrations` by default; summarised as a count.
 */
export const IntegrationStatusSchema = z.enum([
  'bound',
  'needs_credentials',
  'disabled',
  'definition-only',
]);
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

import { IntegrationCredentialStatusSchema } from './credentialStatus.js';

export * from './credentialStatus.js';

/**
 * Summary-level integration entry. One per (definition, binding) tuple.
 * Definition-only integrations (no binding) emit a single row with
 * `bindingId` absent and `status: 'definition-only'`.
 *
 * Used by:
 * - `SpaceContext.integrations.items`
 * - `integration.registry.list`
 * - `catalog.tool.list` directory mode
 * - Operator UI `/integrations`
 */
export const IntegrationDescriptorSchema = z.object({
  sourceKind: IntegrationSourceKindSchema,
  /** API definition `apiId` or MCP server definition `serverId`. */
  integrationId: z.string().min(1).max(128),
  /** Present once a binding row is selected. Absent for definition-only entries. */
  bindingId: z.string().min(1).max(128).optional(),
  /** Definition `name` (human-readable). */
  name: z.string().min(1).max(256),
  /** Definition `description`. */
  description: z.string().max(2048).optional(),
  status: IntegrationStatusSchema,
  /** Number of callable tools this integration exposes when status='bound'. 0 otherwise. */
  toolCount: z.number().int().min(0),
  credentialStatus: IntegrationCredentialStatusSchema.optional(),
});
export type IntegrationDescriptor = z.infer<typeof IntegrationDescriptorSchema>;

/**
 * Callable integration tool. Always binding-scoped — `bindingId` is required
 * because tools are only callable through a specific binding's credentials.
 *
 * Used by:
 * - `catalog.tool.search` integration results
 * - `catalog.tool.list` full-schema mode lookup by `toolId`
 *
 * The orchestrator lowers calls by branching on `sourceKind`:
 *   `api` → `api.http.call` with `apiMeta` reconstructed from `toolId`
 *   `mcp` → `mcp.tool.call` with `mcpMeta` reconstructed from `toolId`
 */
export const IntegrationToolDescriptorSchema = z.object({
  sourceKind: IntegrationSourceKindSchema,
  /** API `apiId` or MCP `serverId`. */
  integrationId: z.string().min(1).max(128),
  bindingId: z.string().min(1).max(128),
  /** API endpoint ID or MCP tool name. The source-native callable unit. */
  toolName: z.string().min(1).max(256),
  /** Model-facing native tool name after promotion. May be qualified for multi-binding. */
  callName: z.string().min(1).max(256),
  /**
   * Canonical promotion key — `api:{bindingId}/{toolName}` or
   * `mcp:{bindingId}/{toolName}`. Passed to `catalog.tool.promote` and used as
   * the lowering identity. Never shown as an `operationId`.
   */
  toolId: z.string().min(1).max(384),
  /** Display name (typically the tool's own `name`). */
  name: z.string().min(1).max(256),
  /** Tool description from the source schema (endpoint or MCP cached tool). */
  description: z.string().max(4096),
  /** JSON Schema for the tool's input — pruned/derived for native function-calling. */
  inputSchema: z.record(z.string(), z.unknown()),
  opTaskOnly: z.boolean().optional(),
  /**
   * True when the source schema is potentially stale (MCP cached tools beyond
   * the staleness window, or an API definition revision newer than the
   * binding's pinned hash). The tool is still callable; the flag is a hint
   * for the agent and a refresh trigger for the executor.
   */
  stale: z.boolean().optional(),
});
export type IntegrationToolDescriptor = z.infer<typeof IntegrationToolDescriptorSchema>;

/**
 * Tool ID prefix helpers. The orchestrator uses these to route promotion and
 * lowering — `catalog.tool.promote` branches on the prefix to decide whether
 * to write to `_discoveredApiToolSpecs` or `_discoveredMcpToolSpecs`.
 */
export const INTEGRATION_TOOL_ID_PREFIX = {
  api: 'api:',
  mcp: 'mcp:',
} as const;

/** Parse a binding-scoped integration toolId into its parts, or null. */
export function parseIntegrationToolId(
  toolId: string,
): { sourceKind: IntegrationSourceKind; bindingId: string; toolName: string } | null {
  for (const sourceKind of ['api', 'mcp'] as const) {
    const prefix = INTEGRATION_TOOL_ID_PREFIX[sourceKind];
    if (!toolId.startsWith(prefix)) continue;
    const rest = toolId.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash >= rest.length - 1) return null;
    const bindingId = rest.slice(0, slash);
    const toolName = rest.slice(slash + 1);
    return { sourceKind, bindingId, toolName };
  }
  return null;
}

/** Build an integration toolId from its parts. */
export function buildIntegrationToolId(
  sourceKind: IntegrationSourceKind,
  bindingId: string,
  toolName: string,
): string {
  return `${INTEGRATION_TOOL_ID_PREFIX[sourceKind]}${bindingId}/${toolName}`;
}
export * from './spaceConnection.js';
