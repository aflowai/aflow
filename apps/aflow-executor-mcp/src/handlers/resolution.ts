import type { McpServerBinding, McpServerDefinition } from '@aflow/schemas';
import { extractUrlOrigin, applyToolFilter } from '@aflow/schemas';
import { resolveBindingByScope } from '@aflow/lib';
import { definitionStoreKey, getMcpSpaceStores, type McpHandlerStores } from './types.js';

export type ResolutionFailureReason =
  | 'no_space_id'
  | 'definition_not_found'
  | 'binding_disabled'
  | 'no_binding'
  | 'origin_not_pinned'
  | 'origin_mismatch';

export function isCredentialResolutionReason(reason: ResolutionFailureReason): boolean {
  return reason === 'no_binding' || reason === 'binding_disabled' || reason === 'origin_not_pinned';
}

export interface ResolutionContext {
  tenantId: string;
  spaceId?: string | undefined;
  flowId?: string | undefined;
}

export type ResolutionResult =
  | { ok: true; definition: McpServerDefinition; binding: McpServerBinding }
  | { ok: false; reason: ResolutionFailureReason; message: string };

export function resolveDefinitionAndBinding(
  stores: McpHandlerStores,
  ctx: ResolutionContext,
  serverId: string,
  bindingIdHint?: string,
): ResolutionResult {
  if (!ctx.spaceId) {
    return {
      ok: false,
      reason: 'no_space_id',
      message:
        `Cannot resolve MCP definition "${serverId}" — job has no spaceId. ` +
        'Managed MCP calls require a space context.',
    };
  }

  const slice = getMcpSpaceStores(stores, ctx.tenantId, ctx.spaceId);
  const definition = slice.definitionStore.get(
    definitionStoreKey({ tenantId: ctx.tenantId, spaceId: ctx.spaceId, serverId }),
  );
  if (!definition) {
    return {
      ok: false,
      reason: 'definition_not_found',
      message: `MCP definition "${serverId}" not found in space "${ctx.spaceId}" (definition_not_found)`,
    };
  }

  // Filter candidates by serverId + tenantId, plus optional bindingId hint
  // (task capability grants pass the exact bindingId; bypass scope scoring).
  let candidates = slice.bindingStore.filter(
    (b) => b.serverId === serverId && b.scope.tenantId === ctx.tenantId,
  );
  if (bindingIdHint) {
    candidates = candidates.filter(
      (b) => b.bindingId === bindingIdHint && b.scope.spaceId === ctx.spaceId,
    );
  }
  const binding = resolveBindingByScope(candidates, ctx);
  if (!binding) {
    return {
      ok: false,
      reason: 'no_binding',
      message: `No MCP binding configured for server "${serverId}" in this scope`,
    };
  }
  if (!binding.enabled) {
    return {
      ok: false,
      reason: 'binding_disabled',
      message: `MCP binding "${binding.bindingId}" is disabled (binding_disabled)`,
    };
  }

  if (binding.auth.type !== 'none' && !binding.pinnedOrigin) {
    return {
      ok: false,
      reason: 'origin_not_pinned',
      message:
        `MCP binding "${binding.bindingId}" has credentialed auth but no pinnedOrigin. ` +
        `Run mcp.binding.test before enabling (origin_not_pinned).`,
    };
  }

  if (binding.pinnedOrigin) {
    const defOrigin = extractUrlOrigin(definition.serverUrl);
    if (defOrigin !== binding.pinnedOrigin) {
      return {
        ok: false,
        reason: 'origin_mismatch',
        message: `MCP definition URL origin "${defOrigin}" does not match binding's pinned origin "${binding.pinnedOrigin}" (origin_mismatch)`,
      };
    }
  }

  return { ok: true, definition, binding };
}

// ============================================================================

export type CallAclResult = { ok: true } | { ok: false; message: string };

export function checkToolCallACL(
  definition: McpServerDefinition,
  binding: McpServerBinding,
  toolName: string,
): CallAclResult {
  const synthetic = [{ name: toolName }];
  const passesDefinitionFilter = applyToolFilter(synthetic, definition.toolFilter).length === 1;
  if (!passesDefinitionFilter) {
    return {
      ok: false,
      message:
        `Tool "${toolName}" on server "${definition.serverId}" is blocked by the definition's ` +
        `toolFilter. Update the server definition's Tool permissions to expose it ` +
        `(binding "${binding.bindingId}").`,
    };
  }

  return { ok: true };
}
