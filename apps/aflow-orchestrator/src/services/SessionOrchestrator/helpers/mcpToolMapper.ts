import type { AgentToolSpec, McpCachedTool } from '@aflow/schemas';
import { buildVirtualToolSpec } from '@aflow/schemas';

/**
 * Grant context for mapping a specific MCP binding's tools to AgentToolSpecs.
 * Built from `TaskCapabilityGrant.mcpServers[]` in the delegation path —
 * mirrors `ApiGrantContext` in apiToolMapper.ts.
 */
export interface McpGrantContext {
  capabilityId: string;
  bindingId: string;
  serverId: string;
  /** Specific tool names to promote. Must be non-empty unless `allTools` is true. */
  grantedToolNames: Set<string>;
  /** Explicit broad grant flag. When false, `grantedToolNames` must be non-empty. */
  allTools: boolean;
  /** True when multiple bindings exist for the same serverId — uses capabilityId in callName. */
  useQualifiedName: boolean;
  /** Tool names from definition.toolFilter.opTaskOnly — op-task-only at lowering time. */
  opTaskOnlyToolNames?: Set<string>;
}

/**
 * Map a binding's cached tools to grant-aware AgentToolSpecs.
 *
 * Differences from `mapMcpToolToToolSpec` (`@aflow/schemas`):
 *  - Filters cached tools to only those in the grant (unless `allTools`).
 *  - Uses `bindingId` in the `toolId` (collision-free across multi-binding spaces).
 *  - Uses `capabilityId` in the callName when `useQualifiedName` is true.
 *  - Carries `bindingId` + `capabilityId` in `mcpMeta` for downstream lowering.
 */
export function mapGrantedMcpToolsToToolSpecs(
  serverName: string,
  allBindingTools: McpCachedTool[],
  grant: McpGrantContext,
): AgentToolSpec[] {
  const specs: AgentToolSpec[] = [];

  // Reject malformed grants: no tools listed and not explicitly broad
  if (!grant.allTools && grant.grantedToolNames.size === 0) {
    return [];
  }

  for (const tool of allBindingTools) {
    if (!grant.allTools && !grant.grantedToolNames.has(tool.name)) {
      continue;
    }

    // Binding-scoped toolId — avoids collision when multiple bindings for same serverId
    const toolId = `mcp:${grant.bindingId}/${tool.name}`;
    // callName: qualified when multi-binding, plain when single
    const namePrefix = grant.useQualifiedName ? grant.capabilityId : grant.serverId;
    const callName = `mcp_${namePrefix}.${tool.name}`;

    const spec = buildVirtualToolSpec({
      operationId: toolId,
      stepType: 'mcp',
      name: tool.name,
      description: tool.description || `MCP tool from ${serverName}`,
      inputSchema: tool.inputSchema ?? {
        type: 'object',
      },
      source: 'mcp',
      lowering: 'mcp_call',
      callName,
      mcpMeta: {
        serverId: grant.serverId,
        toolName: tool.name,
        bindingId: grant.bindingId,
        capabilityId: grant.capabilityId,
      },
    });
    if (grant.opTaskOnlyToolNames?.has(tool.name)) {
      spec.governance = { sideEffects: true, opTaskOnly: true };
    }
    specs.push(spec);
  }

  return specs;
}
