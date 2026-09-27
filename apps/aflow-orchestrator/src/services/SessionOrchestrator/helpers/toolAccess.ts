import type { AgentToolSpec, RunAccessGrant } from '@aflow/schemas';
import { buildOperationId, wouldGrantAllowOperation } from '@aflow/schemas';

const API_CALL_OPERATION_ID = buildOperationId('api', 'http', 'call');
const MCP_CALL_OPERATION_ID = buildOperationId('mcp', 'tool', 'call');
const HOST_MCP_CALL_OPERATION_ID = buildOperationId('host', 'mcp', 'call');
const DELEGATE_OPERATION_ID = buildOperationId('agent', 'control', 'delegate');

export interface ToolAccessContext {
  grant: RunAccessGrant | null;
}

/**
 * The operation the orchestrator actually dispatches for a tool spec, and the
 * same answer from a bare tool id for callers that have no spec yet. Lowered
 * specs carry a synthetic operationId (`api:…`, `mcp:…`, an agent id) — grant
 * decisions must be made against the executed operation, at promotion as well
 * as at materialization, or a promote succeeds for a tool the surface will drop.
 *
 * `null` from the id form means the tool is its own operation.
 */
export function loweredOperationForToolId(toolId: string): string | null {
  if (toolId.startsWith('agent:')) return DELEGATE_OPERATION_ID;
  if (toolId.startsWith('api:')) return API_CALL_OPERATION_ID;
  if (toolId.startsWith('mcp:')) return MCP_CALL_OPERATION_ID;
  return null;
}

export function effectiveOperationIdForSpec(spec: AgentToolSpec): string {
  if (spec.lowering === 'api_call') return API_CALL_OPERATION_ID;
  // A server on the operator's machine is reached by the host lane, so the
  // capability that decides is `host.mcp` — the same one the lowered step is
  // gated by at scheduling. Classifying it as `mcp.tool.call` put a space with
  // remote MCP access in front of local tools it could not run, and hid local
  // tools from a profile granted exactly the capability that serves them.
  if (spec.lowering === 'mcp_call') {
    return spec.mcpMeta?.hostBindingId !== undefined
      ? HOST_MCP_CALL_OPERATION_ID
      : MCP_CALL_OPERATION_ID;
  }
  if (spec.lowering === 'delegate') return DELEGATE_OPERATION_ID;
  return spec.operationId;
}

/**
 * Final materialization gate over the assembled tool surface: drop every spec
 * the run's grant would deny, across every tool source.
 */
export function applyToolAccess(
  tools: AgentToolSpec[],
  access: ToolAccessContext | undefined,
): AgentToolSpec[] {
  return tools.filter((spec) =>
    wouldGrantAllowOperation(access?.grant ?? null, effectiveOperationIdForSpec(spec)),
  );
}
